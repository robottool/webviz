// Byte-layout tests for the WebViz C++ SDK payload encoders. These are the
// cross-language contract: the bytes here must match packages/protocol/src/
// binary.ts (and the Python SDK's struct.pack layouts). No socket involved.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "webviz/client.hpp"

static int failures = 0;

static void expect_bytes(const char* what, const std::vector<uint8_t>& got,
                         const std::vector<uint8_t>& want) {
  if (got == want) {
    std::printf("ok   %s (%zu bytes)\n", what, got.size());
    return;
  }
  ++failures;
  std::printf("FAIL %s\n  got :", what);
  for (uint8_t b : got) std::printf(" %02x", b);
  std::printf("\n  want:");
  for (uint8_t b : want) std::printf(" %02x", b);
  std::printf("\n");
}

static void expect_eq(const char* what, long got, long want) {
  if (got == want) {
    std::printf("ok   %s == %ld\n", what, got);
  } else {
    ++failures;
    std::printf("FAIL %s: got %ld want %ld\n", what, got, want);
  }
}

static void expect_str(const char* what, const std::string& got, const std::string& want) {
  if (got == want) {
    std::printf("ok   %s == %s\n", what, got.c_str());
  } else {
    ++failures;
    std::printf("FAIL %s:\n  got : %s\n  want: %s\n", what, got.c_str(), want.c_str());
  }
}

int main() {
  using namespace webviz;

  // 20-byte standard binary header: channel_id=2, ts=1.5, payload_length=8.
  // ts 1.5 -> IEEE754 double 0x3FF8000000000000 -> LE: 00 00 00 00 00 00 F8 3F.
  {
    std::vector<uint8_t> b;
    append_binary_header(b, /*channel*/ 2, /*ts*/ 1.5, /*len*/ 8);
    expect_bytes("binary header", b,
                 {0x01, 0x00, 0x00, 0x00,              // op + 3 reserved
                  0x02, 0x00, 0x00, 0x00,              // channel_id = 2 (LE)
                  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x3F,  // ts = 1.5 (LE f64)
                  0x08, 0x00, 0x00, 0x00});            // payload_length = 8 (LE)
  }

  // wv/Image payload prefix: frame_id="cam", 4x2, RGB8 (=2).
  {
    auto p = image_payload_prefix("cam", 4, 2, ImageFormat::RGB8);
    expect_bytes("image prefix", p,
                 {0x03, 0x00, 0x00, 0x00,  // frame_id len = 3
                  'c', 'a', 'm', 0x04, 0x00, 0x00, 0x00,  // width = 4
                  0x02, 0x00, 0x00, 0x00,                 // height = 2
                  0x02, 0x00, 0x00, 0x00});               // encoding = RGB8(2)
  }

  // wv/PointCloud payload prefix: frame_id="odom", point_count=1, intensity flag.
  {
    auto p = pointcloud_payload_prefix("odom", 1, PC_FLAG_INTENSITY);
    expect_bytes("pointcloud prefix", p,
                 {0x04, 0x00, 0x00, 0x00,  // frame_id len = 4
                  'o', 'd', 'o', 'm', 0x01, 0x00, 0x00, 0x00,  // point_count = 1
                  0x01});                                       // field_flags = 1
  }

  // point_stride: xyz base = 3, +intensity = 4, +rgb = 6, +normal = 6, all combos.
  expect_eq("stride xyz", point_stride(0), 3);
  expect_eq("stride +intensity", point_stride(PC_FLAG_INTENSITY), 4);
  expect_eq("stride +rgb", point_stride(PC_FLAG_RGB), 6);
  expect_eq("stride +normal", point_stride(PC_FLAG_NORMAL), 6);
  expect_eq("stride +intensity+rgb", point_stride(PC_FLAG_INTENSITY | PC_FLAG_RGB), 7);

  // JSON serialization of a wv/Transform-shaped object (arrays via webviz::arr).
  {
    Value tf = {{"frame_id", "base_link"},
                {"parent_frame_id", "odom"},
                {"translation", arr({1.5, 0.0, 0.0})},
                {"rotation", arr({0.0, 0.0, 0.0, 1.0})}};
    expect_str("transform json", tf.dump(),
               "{\"frame_id\":\"base_link\",\"parent_frame_id\":\"odom\","
               "\"translation\":[1.5,0,0],\"rotation\":[0,0,0,1]}");
  }

  // JSON scalar/escape coverage.
  {
    Value v = {{"i", 7}, {"b", true}, {"n", nullptr}, {"s", "a\"b\\c"}};
    expect_str("json scalars", v.dump(),
               "{\"i\":7,\"b\":true,\"n\":null,\"s\":\"a\\\"b\\\\c\"}");
  }

  std::printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED", failures,
              failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
