cmake_minimum_required(VERSION 3.20)
project(ffd_speech_cpu C)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_executable(speech-cpu probe.c)
