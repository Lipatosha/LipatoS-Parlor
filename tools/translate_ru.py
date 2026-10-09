#!/usr/bin/env python3
"""Produce Russian Foundry localization from the English source.
Keeps localization keys and runtime interpolation tokens unchanged.
"""
import concurrent.futures
import json
import os
import pathlib
import random
import re
import threading
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
source = json.loads((ROOT / "languages/en.json").read_text(encoding="utf-8"))
target = ROOT / "languages/ru.json"
previous = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {}
TOKEN = re.compile(r"(\{[^{}]+\}|<[^<>]*>|\\n|\\t|\[\[[^\]]+\]\])")
lock = threading.Lock()
cache = {}
errors = []
translations = {}

def flatten(obj, prefix=()):
    for key, value in obj.items():
        if isinstance(value, dict):
            yield from flatten(value, prefix+(key,))
        elif isinstance(value, str):
            yield prefix+(key,), value

def lookup(obj, path):
    for k in path:
        if not isinstance(obj, dict) or k not in obj: return None
        obj = obj[k]
    return obj

def translate(sentence):
    if not sentence.strip() or not re.search("[A-Za-z]", sentence):
        return sentence
    fragments = TOKEN.split(sentence)
    marked = [f"ZZZKEEP{i}ZZZ" for i in range(len(fragments)) if TOKEN.fullmatch(fragments[i] or "")]
    markers = {}
    for i, f in enumerate(fragments):
        if TOKEN.fullmatch(f or ""):
            marker = f"ZZZKEEP{i}ZZZ"
            markers[marker] = f
            fragments[i] = marker
    text = "".join(fragments)
    if text in cache: return cache[text]
    params = urllib.parse.urlencode({"client":"gtx","sl":"en","tl":"ru","dt":"t","q":text})
    url = "https://translate.googleapis.com/translate_a/single?" + params
    last_error = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0 (compatible; FoundryL10n/1.0)"})
            with urllib.request.urlopen(req, timeout=35) as response:
                data = json.load(response)
            result = "".join(p[0] for p in data[0] if p[0] is not None)
            for marker, original in markers.items():
                if marker not in result:
                    raise ValueError("Interpolation marker missing: "+marker)
                result = result.replace(marker, original)
            if not result.strip():
                raise ValueError("Empty translation")
            with lock: cache[text] = result
            return result
        except Exception as e:
            last_error = e
            time.sleep(min(20, (attempt+1)**2 + random.random()))
    raise RuntimeError(f"Translation failed after retries: {last_error}")

entries = list(flatten(source))
def worker(entry):
    path, original = entry
    old = lookup(previous, path)
    if isinstance(old, str) and old != original and old.strip() and set(TOKEN.findall(old)) == set(TOKEN.findall(original)):
        return path, old
    if not re.search("[A-Za-z]", original):
        return path, original
    value = translate(original)
    if sorted(TOKEN.findall(value)) != sorted(TOKEN.findall(original)):
        raise ValueError("Tokens changed in "+ ".".join(path))
    return path, value

with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
    futures = [executor.submit(worker, entry) for entry in entries]
    for index, future in enumerate(concurrent.futures.as_completed(futures),1):
        try:
            path, value = future.result()
            translations[path] = value
        except Exception as exc:
            errors.append(str(exc))
        if index % 200 == 0:
            print(f"Processed {index}/{len(entries)}; errors: {len(errors)}", flush=True)
if errors:
    raise SystemExit("\n".join(errors[:30]) + f"\nTOTAL ERRORS: {len(errors)}")

def rebuild(obj, prefix=()):
    if isinstance(obj, dict):
        return {k:rebuild(v, prefix+(k,)) for k,v in obj.items()}
    return translations[prefix]
ru = rebuild(source)
target.write_text(json.dumps(ru, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(f"Validated {len(entries)} localized strings, all interpolation placeholders intact.")
