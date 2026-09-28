"""Owned, localhost-only OpenVINO server for the recording summary workflow."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import select
import socket
import threading
import time

import openvino as ov
import openvino_genai as genai
import psutil


def write(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model', type=Path)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--device', choices=['CPU', 'GPU'], required=True)
    args = parser.parse_args()
    model_id = 'Qwen3-1.7B'
    properties = {'PERFORMANCE_HINT': 'LATENCY', 'NUM_STREAMS': '1'}
    if args.device == 'CPU':
        properties['INFERENCE_NUM_THREADS'] = 2
    began = time.monotonic()
    process = psutil.Process()
    stopped = threading.Event()

    def monitor():
        psutil.cpu_percent()
        with (args.directory / 'openvino-resources.jsonl').open('w', encoding='utf-8') as log:
            while not stopped.is_set():
                memory = process.memory_info()
                record = {'elapsed_s': time.monotonic()-began,
                          'available_bytes': psutil.virtual_memory().available,
                          'rss_bytes': memory.rss, 'private_bytes': memory.private,
                          'cpu_percent': psutil.cpu_percent()}
                # The native host owns memory.json; never race its atomic writer.
                write(args.directory / 'openvino-memory.json', record)
                log.write(json.dumps(record) + '\n')
                log.flush()
                stopped.wait(1)

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    pipe = genai.LLMPipeline(str(args.model), args.device, **properties)
    tokenizer = pipe.get_tokenizer()
    loaded = time.monotonic()-began

    def render(body):
        if body['model'] != model_id:
            raise ValueError('Unexpected model identity')
        history = [{'role': m['role'], 'content': m['content'] if isinstance(m['content'], str)
                    else ''.join(p['text'] for p in m['content'] if p['type'] == 'text')}
                   for m in body['messages']]
        prompt = tokenizer.apply_chat_template(history, True, extra_context=body['chat_template_kwargs'])
        if not prompt.endswith('<think>\n\n</think>\n\n'):
            raise ValueError('Non-thinking template not applied')
        return prompt

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, data):
            encoded = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            self.reply(200 if self.path == '/health' else 404, {'model': model_id, 'device': args.device})

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path == '/apply-template':
                    return self.reply(200, {'prompt': render(body)})
                if self.path == '/tokenize':
                    tokens = tokenizer.encode(body['content'], add_special_tokens=False).input_ids.data[0].tolist()
                    return self.reply(200, {'tokens': tokens})
                if self.path != '/v1/chat/completions':
                    return self.reply(404, {'error': 'Unknown endpoint'})
                inputs = tokenizer.encode(render(body), add_special_tokens=False)
                if inputs.input_ids.shape[-1] + body['max_tokens'] > 6144:
                    raise ValueError('Request exceeds context budget')
                config = pipe.get_generation_config()
                config.max_new_tokens = body['max_tokens']
                config.do_sample = body['temperature'] > 0
                config.temperature = body['temperature'] if config.do_sample else 1.0
                config.top_p = body['top_p']
                config.top_k = body['top_k']
                config.repetition_penalty = body['repeat_penalty']
                config.presence_penalty = body['presence_penalty']
                config.rng_seed = body['seed']
                config.apply_chat_template = False
                config.ignore_eos = False
                if body['min_p'] != 0 or body['repeat_penalty'] != 1 or body['stream']:
                    raise ValueError('Probe only supports the established summary sampling profile')
                config.validate()
                start = time.monotonic()
                def cancelled(_text):
                    if time.monotonic()-start >= 600:
                        return True
                    # Stop a discarded recording note before the final-tail request starts.
                    try:
                        readable, _, _ = select.select([self.connection], [], [], 0)
                        return bool(readable) and not self.connection.recv(1, socket.MSG_PEEK)
                    except OSError:
                        return True

                result = pipe.generate(inputs, config, cancelled)
                if time.monotonic()-start >= 600:
                    raise TimeoutError('Generation exceeded 600 seconds')
                metrics = result.perf_metrics
                response = {'model': model_id, 'device': args.device,
                            'generation_config': {'do_sample': config.do_sample,
                                                  'repetition_penalty': config.repetition_penalty},
                            'choices': [{'finish_reason': 'stop' if result.finish_reasons[0] == genai.GenerationFinishReason.STOP else 'length',
                                         'message': {'role': 'assistant', 'content': tokenizer.decode(result.tokens[0])}}],
                            'usage': {'prompt_tokens': metrics.get_num_input_tokens(),
                                      'completion_tokens': metrics.get_num_generated_tokens()},
                            'timings': {'elapsed_s': time.monotonic()-start, 'ttft_ms': metrics.get_ttft().mean,
                                        'tpot_ms': metrics.get_tpot().mean, 'tokens_per_second': metrics.get_throughput().mean}}
                self.reply(200, response)
            except Exception as error:
                self.reply(500, {'error': repr(error)})

    server = HTTPServer(('127.0.0.1', 0), Handler)
    write(args.directory / 'openvino-server.json', {'pid': process.pid, 'base': f'http://127.0.0.1:{server.server_port}',
          'model': model_id, 'model_path': str(args.model), 'device': args.device, 'properties': properties,
          'openvino_version': ov.__version__, 'load_compile_s': loaded})
    try:
        server.serve_forever()
    finally:
        stopped.set()
        thread.join()
        server.server_close()


if __name__ == '__main__':
    main()
