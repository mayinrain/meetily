"""Minimal binding to the official NeMo-Speech.cpp v0.1.0 diarization C ABI.

ABI: https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.1.0/include/nemo_speech/diar.h
One instance keeps one meeting's stream and must be closed before releasing the library.
"""
import ctypes as c
import os
from pathlib import Path

import numpy as np


class ModelConfig(c.Structure):
    _fields_ = [('size', c.c_size_t), ('model_path', c.c_char_p), ('gpu', c.c_int32),
                ('preset', c.c_char_p), ('chunk_frames', c.c_int32),
                ('right_context_frames', c.c_int32), ('left_context_frames', c.c_int32),
                ('fifo_frames', c.c_int32), ('spkcache_frames', c.c_int32),
                ('update_period_frames', c.c_int32)]


class Segment(c.Structure):
    _fields_ = [('start_time', c.c_double), ('end_time', c.c_double), ('speaker', c.c_int32)]


class NativeSpeakerStream:
    def __init__(self, library, model, gpu=-1):
        self.model, self.stream = c.c_void_p(), c.c_void_p()
        self.finished = False
        library = Path(library).resolve()
        self.dll_directory = os.add_dll_directory(str(library.parent)) if os.name == 'nt' else None
        self.lib = c.CDLL(str(library))
        signatures = {
            'nemo_speech_asr_last_error': ([], c.c_char_p),
            'nemo_speech_diar_create': ([c.POINTER(ModelConfig), c.POINTER(c.c_void_p)], c.c_int),
            'nemo_speech_diar_destroy': ([c.c_void_p], None),
            'nemo_speech_diar_stream_open': ([c.c_void_p, c.POINTER(c.c_void_p)], c.c_int),
            'nemo_speech_diar_stream_push_f32': ([c.c_void_p, c.POINTER(c.c_float), c.c_size_t, c.c_int32], c.c_int),
            'nemo_speech_diar_stream_finish': ([c.c_void_p], c.c_int),
            'nemo_speech_diar_stream_close': ([c.c_void_p], None),
            'nemo_speech_diar_segments': ([c.c_void_p, c.c_void_p, c.POINTER(Segment), c.c_size_t, c.POINTER(c.c_size_t)], c.c_int),
            'nemo_speech_diar_frame_count': ([c.c_void_p], c.c_int64),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = arguments, result
        config = ModelConfig(size=c.sizeof(ModelConfig), model_path=os.fsencode(Path(model).resolve()),
                             gpu=gpu, preset=b'streaming', left_context_frames=-1)
        try:
            self.check(self.lib.nemo_speech_diar_create(c.byref(config), c.byref(self.model)))
            self.check(self.lib.nemo_speech_diar_stream_open(self.model, c.byref(self.stream)))
        except BaseException:
            self.close()
            raise

    def check(self, status):
        if status:
            message = self.lib.nemo_speech_asr_last_error()
            raise RuntimeError(message.decode('utf-8', errors='replace') if message else f'Native error {status}')

    def push(self, samples, sample_rate=16000):
        if self.finished or not self.stream.value:
            raise RuntimeError('Speaker stream is finished or closed')
        samples = np.asarray(samples, dtype=np.float32, order='C')
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError('Expected finite mono float32 audio')
        self.check(self.lib.nemo_speech_diar_stream_push_f32(
            self.stream, samples.ctypes.data_as(c.POINTER(c.c_float)), len(samples), sample_rate))

    def turns(self):
        count = c.c_size_t()
        self.check(self.lib.nemo_speech_diar_segments(self.stream, None, None, 0, c.byref(count)))
        output = (Segment*count.value)()
        self.check(self.lib.nemo_speech_diar_segments(self.stream, None, output, len(output), c.byref(count)))
        return [dict(start=t.start_time, end=t.end_time, speaker=t.speaker) for t in output[:count.value]]

    def finish(self):
        if not self.finished:
            self.check(self.lib.nemo_speech_diar_stream_finish(self.stream))
            self.finished = True
        return self.turns()

    def close(self):
        if self.stream.value:
            self.lib.nemo_speech_diar_stream_close(self.stream)
            self.stream = c.c_void_p()
        if self.model.value:
            self.lib.nemo_speech_diar_destroy(self.model)
            self.model = c.c_void_p()
        if self.dll_directory is not None:
            self.dll_directory.close()
            self.dll_directory = None
