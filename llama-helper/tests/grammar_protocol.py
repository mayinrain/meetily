"""Real helper regression: python grammar_protocol.py HELPER MODEL OUTPUT_DIR.

Requires a local GGUF; no model download or GUI. Retains the protocol and stderr
on failure, including a native abort caused by accepting a sampled token twice.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def main():
    helper, model, output = map(Path, sys.argv[1:])
    output.mkdir(parents=True, exist_ok=False)
    base = dict(type="generate", model_path=str(model.resolve()),
                context_size=512, max_tokens=16, temperature=0.0, top_k=20,
                top_p=0.8, presence_penalty=0.0, frequency_penalty=0.0,
                repeat_penalty=1.0, penalty_last_n=0,
                prompt="Say OK.", stop_tokens=[])
    sampled = dict(base, prompt="Write a short, surprising sentence.",
                   max_tokens=32, temperature=1.0, top_k=40, seed=42)
    requests = [dict(base, grammar='root ::= "OK"'),
                dict(base, grammar='root ::= missing'),
                dict(base, grammar='root ::= "OK"'),
                base, sampled, sampled, dict(type="shutdown")]
    payload = "".join(json.dumps(r) + "\n" for r in requests).encode()
    (output / "requests.jsonl").write_bytes(payload)
    config = dict(helper=str(helper.resolve()), model=str(model.resolve()),
                  helper_sha256=hashlib.sha256(helper.read_bytes()).hexdigest(),
                  timeout_s=60)
    with model.open("rb") as stream:
        config["model_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    (output / "config.json").write_text(json.dumps(config, indent=2))
    started = time.monotonic()
    with (output / "responses.jsonl").open("wb") as stdout, \
            (output / "helper.log").open("wb") as stderr:
        process = subprocess.run([str(helper.resolve())], input=payload,
                                 stdout=stdout, stderr=stderr, timeout=60)
    result = dict(exit_code=process.returncode, elapsed_s=time.monotonic()-started)
    (output / "status.json").write_text(json.dumps(result, indent=2))
    assert process.returncode == 0, f"Helper exited {process.returncode}; see {output}"
    records = [json.loads(line) for line in (output / "responses.jsonl").read_text(encoding="utf-8").splitlines()]
    responses = [r for r in records if r["type"] == "response"]
    assert len(responses) == 6, responses
    for i in (0, 2):
        assert responses[i].get("text") == "OK" and not responses[i].get("error"), responses[i]
    assert "Invalid output grammar" in responses[1].get("error", ""), responses[1]
    assert not responses[1].get("text"), responses[1]
    assert responses[3].get("text") and not responses[3].get("error"), responses[3]
    assert responses[4].get("text") and not responses[4].get("error"), responses[4]
    assert responses[4] == responses[5], "Fixed-seed requests differ"
    assert (output / "helper.log").read_text(encoding="utf-8").count("Sampling seed: 42\n") == 2
    assert records[-1]["type"] == "goodbye", records[-1]
    result["protocol_checks_passed"] = True
    (output / "status.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
