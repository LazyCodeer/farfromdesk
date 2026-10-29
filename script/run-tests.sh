#!/bin/sh
# Sanitize Node startup hooks before the first Node process starts.
set -eu
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_V8_COVERAGE
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/run_node_tests.mjs" "$@"
