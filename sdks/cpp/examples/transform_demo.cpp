// WebViz C++ SDK demo: publish a moving wv/Transform + a rotating wv/Log line.
// Mirrors sdks/python/robot_demo.py's base_transform over the WS source path.
//
//   ./transform_demo [ws://localhost:7777]
//
// Open the app, add a 3D tab (fixed frame "odom") to watch base_link orbit, and
// a Log tab to see the log stream.

#include <chrono>
#include <cmath>
#include <string>
#include <thread>

#include "webviz/client.hpp"

int main(int argc, char** argv) {
  std::string url = (argc > 1) ? argv[1] : "ws://localhost:7777?role=source&id=cpp_demo";

  webviz::Client client(url);
  auto tf = client.advertise("transforms", "wv/Transform");
  auto log = client.advertise("log", "wv/Log");

  std::printf("publishing transforms + log to %s (Ctrl+C to stop)\n", url.c_str());

  const char* levels[] = {"INFO", "INFO", "INFO", "WARN", "ERROR"};
  double t = 0.0;
  for (long i = 0; client.is_open(); ++i, t += 0.05) {
    double yaw = t * 0.2 + M_PI / 2;
    double qz = std::sin(yaw / 2), qw = std::cos(yaw / 2);
    tf.send({{"frame_id", "base_link"},
             {"parent_frame_id", "odom"},
             {"translation", webviz::arr({1.5 * std::cos(t * 0.2), 1.5 * std::sin(t * 0.2), 0.0})},
             {"rotation", webviz::arr({0.0, 0.0, qz, qw})}});

    if (i % 20 == 0) {  // ~1 Hz log line
      log.send({{"level", levels[(i / 20) % 5]},
                {"name", "cpp_demo"},
                {"message", std::string("tick ") + std::to_string(i / 20)}});
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  std::printf("connection closed\n");
  return 0;
}
