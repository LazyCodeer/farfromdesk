@echo off
rem Sanitize Node startup hooks before the first Node process starts.
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE_EXTRA_CA_CERTS="
set "NODE_V8_COVERAGE="
node "%~dp0run_node_tests.mjs" %*
exit /b %ERRORLEVEL%
