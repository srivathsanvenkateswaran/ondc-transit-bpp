#!/usr/bin/env python3
"""Restart the collapsed stack and time its first valid two-callback search."""

import json
import subprocess
import time
import urllib.error
import urllib.request


def available(url):
    try:
        with urllib.request.urlopen(url, timeout=0.5) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def main():
    subprocess.run(["docker", "compose", "down"], check=True)
    started = time.perf_counter()
    subprocess.run(
        ["docker", "compose", "up", "-d", "--no-build"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    deadline = started + 60
    while time.perf_counter() < deadline:
        if available("http://127.0.0.1:5001/readyz") and available(
            "http://127.0.0.1:7001/healthz"
        ):
            break
        time.sleep(0.05)
    else:
        raise SystemExit("stack did not become ready within 60 seconds")

    with open(
        "phase-2/evidence/stack-smoke-search-request.json", encoding="utf-8"
    ) as template_file:
        template = json.load(template_file)
    request = urllib.request.Request(
        "http://127.0.0.1:5001/search",
        data=build_request(template),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    search_started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=15) as response:
        body = json.load(response)
    finished = time.perf_counter()
    callbacks = body.get("responses", [])
    if len(callbacks) != 2:
        raise SystemExit(f"first search returned {len(callbacks)} callbacks")
    print(
        json.dumps(
            {
                "cold_start_to_working_search_seconds": round(finished - started, 6),
                "first_search_round_trip_seconds": round(finished - search_started, 6),
                "callbacks": len(callbacks),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    import importlib.util
    import pathlib
    load_path = pathlib.Path(__file__).with_name("measure-load.py")
    spec = importlib.util.spec_from_file_location("measure_load", load_path)
    measure_load = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(measure_load)
    build_request = measure_load.build_request
    main()
