// WebViz C++ SDK demo: stream an animated binary wv/PointCloud (xyz + intensity).
// Mirrors sdks/python/pointcloud_demo.py and exercises the zero-copy send path.
//
//   ./pointcloud_demo [ws://localhost:7777]
//
// Open the app, add a 3D tab (fixed frame "odom"), and add a PointCloud display
// bound to the "lidar_points" channel.

#include <chrono>
#include <cmath>
#include <string>
#include <thread>
#include <vector>

#include "webviz/client.hpp"

int main(int argc, char** argv) {
  std::string url = (argc > 1) ? argv[1] : "ws://localhost:7777?role=source&id=cpp_pc";

  webviz::Client client(url);
  auto cloud = client.advertise("lidar_points", "wv/PointCloud", webviz::Encoding::Binary);

  std::printf("streaming wv/PointCloud to %s (Ctrl+C to stop)\n", url.c_str());

  const int kRings = 32;
  const int kPerRing = 128;
  const uint32_t kCount = kRings * kPerRing;
  std::vector<float> pts;       // interleaved x, y, z, intensity
  pts.reserve(kCount * 4);

  double t = 0.0;
  while (client.is_open()) {
    pts.clear();
    for (int r = 0; r < kRings; ++r) {
      double z = (r / double(kRings) - 0.5) * 2.0;
      double radius = 2.0 + std::sin(t + z * 2.0) * 0.5;
      for (int a = 0; a < kPerRing; ++a) {
        double ang = (a / double(kPerRing)) * 2.0 * M_PI;
        pts.push_back(static_cast<float>(radius * std::cos(ang)));
        pts.push_back(static_cast<float>(radius * std::sin(ang)));
        pts.push_back(static_cast<float>(z));
        pts.push_back(static_cast<float>(0.5 + 0.5 * std::sin(ang * 3.0 + t)));  // intensity
      }
    }
    cloud.send_pointcloud("odom", kCount, webviz::PC_FLAG_INTENSITY, pts.data());
    t += 0.05;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  std::printf("connection closed\n");
  return 0;
}
