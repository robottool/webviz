# WebViz C++ SDK (§6.3) — header-only client + examples + byte-layout test.
#
#   cmake -S . -B build && cmake --build build
#   ctest --test-dir build --output-on-failure      # runs the byte-layout test
#   ./build/transform_demo                           # needs a running hub
#
# The SDK itself is header-only (include/webviz/client.hpp); nothing to build to
# *use* it — just add this dir's include/ to your include path. The targets here
# are the test and the runnable demos.

cmake_minimum_required(VERSION 3.14)
project(webviz_cpp_sdk LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Header-only interface library — link this to pull in the include path.
add_library(webviz_client INTERFACE)
target_include_directories(webviz_client INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

find_package(Threads REQUIRED)
target_link_libraries(webviz_client INTERFACE Threads::Threads)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

# --- examples ---
add_executable(transform_demo examples/transform_demo.cpp)
target_link_libraries(transform_demo PRIVATE webviz_client)

add_executable(pointcloud_demo examples/pointcloud_demo.cpp)
target_link_libraries(pointcloud_demo PRIVATE webviz_client)

# --- test (no network) ---
enable_testing()
add_executable(test_payloads test/test_payloads.cpp)
target_link_libraries(test_payloads PRIVATE webviz_client)
add_test(NAME payloads COMMAND test_payloads)
