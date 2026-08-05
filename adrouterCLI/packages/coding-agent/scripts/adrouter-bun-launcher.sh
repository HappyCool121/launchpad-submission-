#!/bin/sh
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
exec "$(dirname "$0")/adrouter-bin" "$@"
