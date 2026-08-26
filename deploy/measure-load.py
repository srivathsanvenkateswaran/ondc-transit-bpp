#!/usr/bin/env python3
"""Measure synchronous search throughput and latency with fresh correlation IDs."""

import argparse
import concurrent.futures
import datetime
import json
import math
import time
import urllib.request
import uuid


def percentile(values, percentile_value):
    ordered = sorted(values)
    index = max(0, math.ceil(percentile_value * len(ordered)) - 1)
    return ordered[index]


def build_request(template):
    body = json.loads(json.dumps(template))
    body["context"]["transaction_id"] = str(uuid.uuid4())
    body["context"]["message_id"] = str(uuid.uuid4())
    body["context"]["timestamp"] = (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    return json.dumps(body, separators=(",", ":")).encode()


def send_one(url, template, timeout):
    request = urllib.request.Request(
        url,
        data=build_request(template),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.load(response)
        status = response.status
    elapsed = time.perf_counter() - started
    callbacks = body.get("responses")
    valid = status == 200 and isinstance(callbacks, list) and len(callbacks) == 2
    return elapsed, valid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5001/search")
    parser.add_argument(
        "--template",
        default="phase-2/evidence/stack-smoke-search-request.json",
    )
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if args.requests < 1 or args.concurrency < 1:
        parser.error("requests and concurrency must be positive")

    with open(args.template, encoding="utf-8") as template_file:
        template = json.load(template_file)

    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency
    ) as executor:
        futures = [
            executor.submit(send_one, args.url, template, args.timeout)
            for _ in range(args.requests)
        ]
        results = [future.result() for future in futures]
    wall_time = time.perf_counter() - started
    latencies = [elapsed for elapsed, _ in results]
    successes = sum(1 for _, valid in results if valid)
    report = {
        "url": args.url,
        "requests": args.requests,
        "concurrency": args.concurrency,
        "successful_two_callback_responses": successes,
        "wall_seconds": round(wall_time, 6),
        "requests_per_second": round(args.requests / wall_time, 3),
        "latency_ms": {
            "p50": round(percentile(latencies, 0.50) * 1000, 3),
            "p95": round(percentile(latencies, 0.95) * 1000, 3),
            "p99": round(percentile(latencies, 0.99) * 1000, 3),
            "max": round(max(latencies) * 1000, 3),
        },
    }
    print(json.dumps(report, indent=2))
    if successes != args.requests:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
