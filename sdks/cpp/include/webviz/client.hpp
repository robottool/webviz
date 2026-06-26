// WebViz C++ SDK (§6.3) — header-only data-source client.
//
// A minimal, dependency-free WebSocket client that advertises channels and
// pushes JSON / binary frames following the WebViz wire protocol. It mirrors
// `sdks/python/webviz/client.py` and the binary layouts in
// `packages/protocol/src/binary.ts` (keep all three in sync — see CLAUDE.md
// "When changing the protocol").
//
// Design (per the design doc):
//   * Header-only, POSIX sockets only (Linux/macOS). No OpenSSL, no Boost —
//     it speaks just enough RFC 6455 to talk to the hub (ws:// only).
//   * Zero-copy binary framing: send_binary / send_image / send_pointcloud use
//     scatter-gather writev() so a large camera/point-cloud buffer is never
//     copied into an intermediate frame buffer.
//
// A WebViz hub is a trusted LAN/edge broker, so every client frame is sent with
// an all-zero WebSocket mask key (RFC 6455 §5.3 requires the MASK bit but the
// key value is unmask-identity). That is what makes the zero-copy path possible
// — masking with a random key would force us to XOR (and therefore copy) every
// payload byte. Do not reuse this client across an untrusted proxy.
//
// Usage:
//   webviz::Client client("ws://localhost:7777?role=source&id=cpp");
//   auto tf = client.advertise("transforms", "wv/Transform");
//   tf.send({{"frame_id","base_link"},{"parent_frame_id","odom"},
//            {"translation", webviz::arr({x, y, 0.0})},
//            {"rotation",    webviz::arr({qx, qy, qz, qw})}});
//   auto cam = client.advertise("camera_front", "wv/Image", webviz::Encoding::Binary);
//   cam.send_image("camera", w, h, webviz::ImageFormat::JPEG, jpeg.data(), jpeg.size());

#ifndef WEBVIZ_CLIENT_HPP
#define WEBVIZ_CLIENT_HPP

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <mutex>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace webviz {

// --- protocol constants (mirror binary.ts) ---
constexpr uint8_t BINARY_OP = 0x01;
constexpr size_t HEADER_SIZE = 20;

// wv/PointCloud field flags (mirror binary.ts).
constexpr uint8_t PC_FLAG_INTENSITY = 0b001;
constexpr uint8_t PC_FLAG_RGB = 0b010;
constexpr uint8_t PC_FLAG_NORMAL = 0b100;

enum class Encoding { Json, Binary };

// wv/Image encoding enum (matches schemas.ts ImageEncoding / the binary header).
enum class ImageFormat : uint32_t { JPEG = 0, PNG = 1, RGB8 = 2 };

inline const char* encoding_str(Encoding e) {
  return e == Encoding::Binary ? "binary" : "json";
}

// --- little-endian serialization helpers (explicit, host-endian-independent) ---
inline void put_u8(std::vector<uint8_t>& b, uint8_t v) { b.push_back(v); }

inline void put_u32_le(std::vector<uint8_t>& b, uint32_t v) {
  b.push_back(static_cast<uint8_t>(v & 0xff));
  b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
  b.push_back(static_cast<uint8_t>((v >> 16) & 0xff));
  b.push_back(static_cast<uint8_t>((v >> 24) & 0xff));
}

inline void put_f64_le(std::vector<uint8_t>& b, double v) {
  uint64_t bits;
  std::memcpy(&bits, &v, sizeof(bits));
  for (int i = 0; i < 8; ++i) b.push_back(static_cast<uint8_t>((bits >> (8 * i)) & 0xff));
}

inline void put_bytes(std::vector<uint8_t>& b, const void* p, size_t n) {
  const uint8_t* s = static_cast<const uint8_t*>(p);
  b.insert(b.end(), s, s + n);
}

// --- minimal JSON value for the `data` payload of a `message` frame ---
//
// Objects are written `{{"key", value}, ...}`; arrays use `webviz::arr({...})`
// to disambiguate from objects. Numbers/strings/bools/null convert implicitly.
class Value {
 public:
  enum class Type { Null, Bool, Int, Double, String, Array, Object };

  Value() : type_(Type::Null) {}
  Value(std::nullptr_t) : type_(Type::Null) {}
  Value(bool b) : type_(Type::Bool), bool_(b) {}
  Value(int i) : type_(Type::Int), int_(i) {}
  Value(long i) : type_(Type::Int), int_(i) {}
  Value(long long i) : type_(Type::Int), int_(i) {}
  Value(unsigned i) : type_(Type::Int), int_(i) {}
  Value(unsigned long i) : type_(Type::Int), int_(static_cast<long long>(i)) {}
  Value(double d) : type_(Type::Double), dbl_(d) {}
  Value(float d) : type_(Type::Double), dbl_(d) {}
  Value(const char* s) : type_(Type::String), str_(s) {}
  Value(std::string s) : type_(Type::String), str_(std::move(s)) {}

  // Object: initializer list of (key, value) pairs.
  Value(std::initializer_list<std::pair<const char*, Value>> obj) : type_(Type::Object) {
    for (const auto& kv : obj) obj_.emplace_back(kv.first, kv.second);
  }

  // Array factory (use webviz::arr(...) below).
  static Value array(std::initializer_list<Value> items) {
    Value v;
    v.type_ = Type::Array;
    v.arr_.assign(items.begin(), items.end());
    return v;
  }

  void serialize(std::string& out) const {
    switch (type_) {
      case Type::Null:
        out += "null";
        break;
      case Type::Bool:
        out += bool_ ? "true" : "false";
        break;
      case Type::Int: {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", int_);
        out += buf;
        break;
      }
      case Type::Double: {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.17g", dbl_);
        out += buf;
        break;
      }
      case Type::String:
        escape(str_, out);
        break;
      case Type::Array: {
        out += '[';
        for (size_t i = 0; i < arr_.size(); ++i) {
          if (i) out += ',';
          arr_[i].serialize(out);
        }
        out += ']';
        break;
      }
      case Type::Object: {
        out += '{';
        for (size_t i = 0; i < obj_.size(); ++i) {
          if (i) out += ',';
          escape(obj_[i].first, out);
          out += ':';
          obj_[i].second.serialize(out);
        }
        out += '}';
        break;
      }
    }
  }

  std::string dump() const {
    std::string s;
    serialize(s);
    return s;
  }

 private:
  static void escape(const std::string& s, std::string& out) {
    out += '"';
    for (char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
          } else {
            out += c;
          }
      }
    }
    out += '"';
  }

  Type type_;
  bool bool_ = false;
  long long int_ = 0;
  double dbl_ = 0;
  std::string str_;
  std::vector<Value> arr_;
  std::vector<std::pair<std::string, Value>> obj_;
};

inline Value arr(std::initializer_list<Value> items) { return Value::array(items); }

// --- payload encoders (pure; mirror binary.ts, testable without a socket) ---

// Append the 20-byte standard binary frame header. `payload_length` is the
// number of payload bytes that follow the header.
inline void append_binary_header(std::vector<uint8_t>& b, uint32_t channel_id, double timestamp,
                                 uint32_t payload_length) {
  put_u8(b, BINARY_OP);
  put_u8(b, 0);
  put_u8(b, 0);
  put_u8(b, 0);  // 3 reserved
  put_u32_le(b, channel_id);
  put_f64_le(b, timestamp);
  put_u32_le(b, payload_length);
}

// wv/Image payload prefix: u32 frame_id len, frame_id, u32 w, u32 h, u32 encoding.
// (The raw image bytes follow this prefix.)
inline std::vector<uint8_t> image_payload_prefix(const std::string& frame_id, uint32_t width,
                                                 uint32_t height, ImageFormat encoding) {
  std::vector<uint8_t> p;
  put_u32_le(p, static_cast<uint32_t>(frame_id.size()));
  put_bytes(p, frame_id.data(), frame_id.size());
  put_u32_le(p, width);
  put_u32_le(p, height);
  put_u32_le(p, static_cast<uint32_t>(encoding));
  return p;
}

// wv/PointCloud payload prefix: u32 frame_id len, frame_id, u32 point_count,
// u8 field_flags. (The interleaved float32 data follows this prefix.)
inline std::vector<uint8_t> pointcloud_payload_prefix(const std::string& frame_id,
                                                      uint32_t point_count, uint8_t field_flags) {
  std::vector<uint8_t> p;
  put_u32_le(p, static_cast<uint32_t>(frame_id.size()));
  put_bytes(p, frame_id.data(), frame_id.size());
  put_u32_le(p, point_count);
  put_u8(p, field_flags);
  return p;
}

// Float32 values per point implied by `field_flags` (xyz = 3 base).
inline uint32_t point_stride(uint8_t field_flags) {
  uint32_t stride = 3;
  if (field_flags & PC_FLAG_INTENSITY) stride += 1;
  if (field_flags & PC_FLAG_RGB) stride += 3;
  if (field_flags & PC_FLAG_NORMAL) stride += 3;
  return stride;
}

inline double now_seconds() {
  using namespace std::chrono;
  return duration<double>(system_clock::now().time_since_epoch()).count();
}

class Client;

// A single advertised channel; send frames through it.
class Channel {
 public:
  Channel(Client* client, uint32_t id, Encoding encoding)
      : client_(client), id_(id), encoding_(encoding) {}

  uint32_t id() const { return id_; }
  Encoding encoding() const { return encoding_; }

  // JSON `message` frame (text). `data` is the schema payload object.
  void send(const Value& data, double timestamp = -1);

  // Raw binary frame: a 20-byte header wraps `payload` (zero-copy via writev).
  void send_binary(const void* payload, size_t len, double timestamp = -1);

  // wv/Image: prefix + raw image bytes (zero-copy — `data` is not copied).
  void send_image(const std::string& frame_id, uint32_t width, uint32_t height, ImageFormat encoding,
                  const void* data, size_t len, double timestamp = -1);

  // wv/PointCloud: prefix + interleaved float32 data (zero-copy). `floats` is
  // `point_count * point_stride(field_flags)` values, xyz first.
  void send_pointcloud(const std::string& frame_id, uint32_t point_count, uint8_t field_flags,
                       const float* floats, double timestamp = -1);

 private:
  Client* client_;
  uint32_t id_;
  Encoding encoding_;
};

class Client {
 public:
  // url: ws://host[:port][/path][?query]. Connects immediately (throws on failure).
  explicit Client(const std::string& url, bool background_reader = true) {
    parse_url(url);
    connect_socket();
    handshake();
    if (background_reader) {
      reader_ = std::thread([this] { read_loop(); });
    }
  }

  ~Client() { close(); }

  Client(const Client&) = delete;
  Client& operator=(const Client&) = delete;

  Channel advertise(const std::string& name, const std::string& schema,
                    Encoding encoding = Encoding::Json) {
    uint32_t id;
    {
      std::lock_guard<std::mutex> lk(send_mtx_);
      id = next_id_++;
    }
    Value adv = {{"op", "advertise"},
                 {"channel", Value{{"id", static_cast<long long>(id)},
                                   {"name", name},
                                   {"schema", schema},
                                   {"encoding", encoding_str(encoding)}}}};
    send_text(adv.dump());
    return Channel(this, id, encoding);
  }

  void unadvertise(const std::string& name) {
    Value msg = {{"op", "unadvertise"}, {"channel_name", name}};
    send_text(msg.dump());
  }

  bool is_open() const { return open_.load(); }

  void close() {
    bool was = open_.exchange(false);
    if (fd_ >= 0) {
      ::shutdown(fd_, SHUT_RDWR);  // unblock the reader's recv()
    }
    if (reader_.joinable()) reader_.join();
    if (fd_ >= 0) {
      ::close(fd_);
      fd_ = -1;
    }
    (void)was;
  }

 private:
  friend class Channel;

  // --- channel send paths (called by Channel) ---

  void channel_send_json(uint32_t channel_id, const Value& data, double ts) {
    Value msg = {{"op", "message"},
                 {"channel_id", static_cast<long long>(channel_id)},
                 {"timestamp", ts},
                 {"data", data}};
    send_text(msg.dump());
  }

  // prefix = 20-byte header (+ optional schema sub-header); body = bulk data.
  void channel_send_binary(std::vector<uint8_t>& prefix, const void* body, size_t body_len) {
    std::lock_guard<std::mutex> lk(send_mtx_);
    if (!open_.load()) return;
    std::vector<uint8_t> ws = ws_header(0x2, prefix.size() + body_len);
    iovec iov[3];
    iov[0] = {ws.data(), ws.size()};
    iov[1] = {prefix.data(), prefix.size()};
    size_t n = 2;
    if (body_len) {
      iov[2] = {const_cast<void*>(body), body_len};
      n = 3;
    }
    writev_all(iov, n);
  }

  void send_text(const std::string& s) {
    std::lock_guard<std::mutex> lk(send_mtx_);
    if (!open_.load()) return;
    std::vector<uint8_t> ws = ws_header(0x1, s.size());
    iovec iov[2] = {{ws.data(), ws.size()},
                    {const_cast<char*>(s.data()), s.size()}};
    writev_all(iov, s.empty() ? 1 : 2);
  }

  // --- WebSocket framing ---

  // Client frame header with an all-zero mask key (see file header for why).
  static std::vector<uint8_t> ws_header(uint8_t opcode, size_t len) {
    std::vector<uint8_t> h;
    h.push_back(static_cast<uint8_t>(0x80 | opcode));  // FIN + opcode
    if (len < 126) {
      h.push_back(static_cast<uint8_t>(0x80 | len));  // MASK + len
    } else if (len < 65536) {
      h.push_back(static_cast<uint8_t>(0x80 | 126));
      h.push_back(static_cast<uint8_t>((len >> 8) & 0xff));
      h.push_back(static_cast<uint8_t>(len & 0xff));
    } else {
      h.push_back(static_cast<uint8_t>(0x80 | 127));
      for (int i = 7; i >= 0; --i) h.push_back(static_cast<uint8_t>((len >> (8 * i)) & 0xff));
    }
    h.insert(h.end(), {0, 0, 0, 0});  // zero mask key
    return h;
  }

  // Send every byte of an iovec array, handling partial writes. Caller holds send_mtx_.
  void writev_all(iovec* iov, size_t count) {
    size_t i = 0;
    while (i < count) {
      ssize_t w = ::writev(fd_, iov + i, static_cast<int>(count - i));
      if (w <= 0) {
        if (w < 0 && (errno == EINTR)) continue;
        open_.store(false);  // broken pipe / closed
        return;
      }
      size_t wrote = static_cast<size_t>(w);
      while (i < count && wrote >= iov[i].iov_len) {
        wrote -= iov[i].iov_len;
        ++i;
      }
      if (i < count && wrote > 0) {
        iov[i].iov_base = static_cast<uint8_t*>(iov[i].iov_base) + wrote;
        iov[i].iov_len -= wrote;
      }
    }
  }

  // --- connection setup ---

  void parse_url(const std::string& url) {
    std::string rest = url;
    const std::string scheme = "ws://";
    if (rest.rfind(scheme, 0) == 0) rest = rest.substr(scheme.size());
    // host[:port][/path][?query]
    size_t slash = rest.find('/');
    size_t qmark = rest.find('?');
    size_t host_end = std::min(slash, qmark);
    std::string hostport = rest.substr(0, host_end);
    target_ = (host_end == std::string::npos) ? "/" : rest.substr(host_end);
    if (!target_.empty() && target_[0] == '?') target_ = "/" + target_;
    if (target_.empty()) target_ = "/";

    size_t colon = hostport.find(':');
    if (colon == std::string::npos) {
      host_ = hostport;
      port_ = "80";
    } else {
      host_ = hostport.substr(0, colon);
      port_ = hostport.substr(colon + 1);
    }
    if (host_.empty()) host_ = "localhost";
  }

  void connect_socket() {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    int rc = ::getaddrinfo(host_.c_str(), port_.c_str(), &hints, &res);
    if (rc != 0) throw std::runtime_error(std::string("getaddrinfo: ") + gai_strerror(rc));

    int fd = -1;
    for (addrinfo* p = res; p; p = p->ai_next) {
      fd = ::socket(p->ai_family, p->ai_socktype, p->ai_protocol);
      if (fd < 0) continue;
      if (::connect(fd, p->ai_addr, p->ai_addrlen) == 0) break;
      ::close(fd);
      fd = -1;
    }
    ::freeaddrinfo(res);
    if (fd < 0) throw std::runtime_error("webviz: could not connect to " + host_ + ":" + port_);

    int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
#ifdef SO_NOSIGPIPE
    ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
    fd_ = fd;
  }

  void handshake() {
    std::string key = random_key_b64();
    std::string req = "GET " + target_ + " HTTP/1.1\r\n";
    req += "Host: " + host_ + ":" + port_ + "\r\n";
    req += "Upgrade: websocket\r\n";
    req += "Connection: Upgrade\r\n";
    req += "Sec-WebSocket-Key: " + key + "\r\n";
    req += "Sec-WebSocket-Version: 13\r\n\r\n";
    if (!write_all(req.data(), req.size())) throw std::runtime_error("webviz: handshake write failed");

    // Read response headers up to the blank line.
    std::string resp;
    char c;
    while (resp.find("\r\n\r\n") == std::string::npos) {
      ssize_t r = ::recv(fd_, &c, 1, 0);
      if (r <= 0) throw std::runtime_error("webviz: handshake read failed");
      resp += c;
      if (resp.size() > 8192) throw std::runtime_error("webviz: handshake response too large");
    }
    if (resp.find(" 101 ") == std::string::npos) {
      throw std::runtime_error("webviz: server did not upgrade (no 101):\n" + resp.substr(0, 120));
    }
    open_.store(true);
  }

  bool write_all(const void* data, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    size_t off = 0;
    while (off < len) {
#ifdef MSG_NOSIGNAL
      ssize_t w = ::send(fd_, p + off, len - off, MSG_NOSIGNAL);
#else
      ssize_t w = ::send(fd_, p + off, len - off, 0);
#endif
      if (w <= 0) {
        if (w < 0 && errno == EINTR) continue;
        return false;
      }
      off += static_cast<size_t>(w);
    }
    return true;
  }

  static std::string random_key_b64() {
    uint8_t raw[16];
    std::random_device rd;
    for (auto& b : raw) b = static_cast<uint8_t>(rd());
    return base64(raw, sizeof(raw));
  }

  static std::string base64(const uint8_t* data, size_t len) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (size_t i = 0; i < len; i += 3) {
      uint32_t n = data[i] << 16;
      if (i + 1 < len) n |= data[i + 1] << 8;
      if (i + 2 < len) n |= data[i + 2];
      out += tbl[(n >> 18) & 63];
      out += tbl[(n >> 12) & 63];
      out += (i + 1 < len) ? tbl[(n >> 6) & 63] : '=';
      out += (i + 2 < len) ? tbl[n & 63] : '=';
    }
    return out;
  }

  // --- background reader: drain server frames, answer ping, honor close ---

  void read_loop() {
    while (open_.load()) {
      uint8_t h[2];
      if (!read_n(h, 2)) break;
      uint8_t opcode = h[0] & 0x0f;
      bool masked = (h[1] & 0x80) != 0;
      uint64_t len = h[1] & 0x7f;
      if (len == 126) {
        uint8_t e[2];
        if (!read_n(e, 2)) break;
        len = (uint64_t(e[0]) << 8) | e[1];
      } else if (len == 127) {
        uint8_t e[8];
        if (!read_n(e, 8)) break;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | e[i];
      }
      uint8_t mask[4] = {0, 0, 0, 0};
      if (masked && !read_n(mask, 4)) break;

      std::vector<uint8_t> payload(len);
      if (len && !read_n(payload.data(), len)) break;
      if (masked) {
        for (uint64_t i = 0; i < len; ++i) payload[i] ^= mask[i & 3];
      }

      if (opcode == 0x8) {  // close
        open_.store(false);
        break;
      } else if (opcode == 0x9) {  // ping -> pong
        std::lock_guard<std::mutex> lk(send_mtx_);
        if (!open_.load()) break;
        std::vector<uint8_t> ws = ws_header(0xA, payload.size());
        iovec iov[2] = {{ws.data(), ws.size()}, {payload.data(), payload.size()}};
        writev_all(iov, payload.empty() ? 1 : 2);
      }
      // data / pong frames are ignored (a source consumes nothing)
    }
  }

  bool read_n(uint8_t* buf, uint64_t n) {
    uint64_t off = 0;
    while (off < n) {
      ssize_t r = ::recv(fd_, buf + off, n - off, 0);
      if (r <= 0) {
        if (r < 0 && errno == EINTR) continue;
        return false;
      }
      off += static_cast<uint64_t>(r);
    }
    return true;
  }

  std::string host_, port_, target_;
  int fd_ = -1;
  std::atomic<bool> open_{false};
  uint32_t next_id_ = 1;
  std::mutex send_mtx_;
  std::thread reader_;
};

// --- Channel methods (defined after Client) ---

inline void Channel::send(const Value& data, double timestamp) {
  client_->channel_send_json(id_, data, timestamp < 0 ? now_seconds() : timestamp);
}

inline void Channel::send_binary(const void* payload, size_t len, double timestamp) {
  std::vector<uint8_t> prefix;
  append_binary_header(prefix, id_, timestamp < 0 ? now_seconds() : timestamp,
                       static_cast<uint32_t>(len));
  client_->channel_send_binary(prefix, payload, len);
}

inline void Channel::send_image(const std::string& frame_id, uint32_t width, uint32_t height,
                                ImageFormat encoding, const void* data, size_t len, double timestamp) {
  std::vector<uint8_t> meta = image_payload_prefix(frame_id, width, height, encoding);
  uint32_t payload_len = static_cast<uint32_t>(meta.size() + len);
  std::vector<uint8_t> prefix;
  append_binary_header(prefix, id_, timestamp < 0 ? now_seconds() : timestamp, payload_len);
  prefix.insert(prefix.end(), meta.begin(), meta.end());
  client_->channel_send_binary(prefix, data, len);
}

inline void Channel::send_pointcloud(const std::string& frame_id, uint32_t point_count,
                                     uint8_t field_flags, const float* floats, double timestamp) {
  std::vector<uint8_t> meta = pointcloud_payload_prefix(frame_id, point_count, field_flags);
  size_t float_bytes = static_cast<size_t>(point_count) * point_stride(field_flags) * sizeof(float);
  uint32_t payload_len = static_cast<uint32_t>(meta.size() + float_bytes);
  std::vector<uint8_t> prefix;
  append_binary_header(prefix, id_, timestamp < 0 ? now_seconds() : timestamp, payload_len);
  prefix.insert(prefix.end(), meta.begin(), meta.end());
  client_->channel_send_binary(prefix, floats, float_bytes);
}

}  // namespace webviz

#endif  // WEBVIZ_CLIENT_HPP
