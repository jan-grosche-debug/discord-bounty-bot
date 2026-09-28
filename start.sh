#!/usr/bin/env bash
# Starts the bounty bot (Linux / macOS) from any working directory.
cd "$(dirname "$0")" || exit 1
echo "Starting bounty bot..."
exec node bot/index.js
