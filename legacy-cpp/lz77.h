// lz77.h 
#pragma once
#include <vector>
#include <deque>
#include <cstdint>
#include <unordered_map>
#include <ostream>

struct LZ77Token {
    uint16_t offset;
    uint8_t length;
    uint8_t lit;
};

std::vector<LZ77Token> lz77_compress(const std::vector<uint8_t>& data,
                                     size_t windowSize = 65535,
                                     size_t maxMatch = 255);
std::vector<uint8_t> lz77_serialize(const std::vector<LZ77Token>& tokens);
std::vector<LZ77Token> lz77_deserialize(const std::vector<uint8_t>& bytes);
std::vector<uint8_t> lz77_decompress(const std::vector<LZ77Token>& tokens);

// Streaming compressor class 
class LZ77StreamCompressor {
public:
    LZ77StreamCompressor(size_t windowSize = 65535, size_t maxMatch = 255);

    // Feed next chunk of input bytes (append to internal window)
    void feed(const std::vector<uint8_t>& chunk, bool isLast = false);

    // Get serialized output bytes for all emitted tokens so far
    std::vector<uint8_t> consumeOutput();

private:
    size_t windowSize;
    size_t maxMatch;
    std::deque<uint8_t> window;  // sliding window
    std::unordered_map<uint32_t, std::deque<size_t>> dict;
    std::vector<LZ77Token> pendingTokens;
    size_t absolutePos;

    void processChunk(const std::vector<uint8_t>& chunk, bool isLast);
    static inline uint32_t make_key(const uint8_t* p);
};
