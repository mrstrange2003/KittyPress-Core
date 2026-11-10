// lz77.cpp
#include "lz77.h"
#include <algorithm>
#include <cstring>
#include <iostream>

// (serialize/deserialize/decompress)

std::vector<uint8_t> lz77_serialize(const std::vector<LZ77Token> &tokens) {
    std::vector<uint8_t> out;
    out.reserve(tokens.size() * 3);
    for (const auto &t : tokens) {
        if (t.offset == 0 && t.length == 0) {
            out.push_back(0x00);
            out.push_back(t.lit);
        } else {
            out.push_back(0x01);
            out.push_back(static_cast<uint8_t>(t.offset & 0xFF));
            out.push_back(static_cast<uint8_t>((t.offset >> 8) & 0xFF));
            out.push_back(t.length);
        }
    }
    return out;
}

std::vector<LZ77Token> lz77_deserialize(const std::vector<uint8_t> &bytes) {
    std::vector<LZ77Token> tokens;
    size_t i = 0, n = bytes.size();
    while (i < n) {
        uint8_t tag = bytes[i++];
        if (tag == 0x00) {
            if (i >= n) break; // malformed, but break
            LZ77Token t; t.offset = 0; t.length = 0; t.lit = bytes[i++];
            tokens.push_back(t);
        } else if (tag == 0x01) {
            if (i + 2 >= n) break;
            uint16_t lo = bytes[i++];
            uint16_t hi = bytes[i++];
            uint16_t offset = (hi << 8) | lo;
            uint8_t length = bytes[i++];
            LZ77Token t; t.offset = offset; t.length = length; t.lit = 0;
            tokens.push_back(t);
        } else {
            // unknown tag — break for safety
            break;
        }
    }
    return tokens;
}

std::vector<uint8_t> lz77_decompress(const std::vector<LZ77Token> &tokens) {
    std::vector<uint8_t> out;
    out.reserve(tokens.size() * 2);
    for (const auto &t : tokens) {
        if (t.offset == 0 && t.length == 0) {
            out.push_back(t.lit);
        } else {
            size_t start = out.size() - t.offset;
            for (size_t k = 0; k < t.length; ++k) {
                out.push_back(out[start + k]);
            }
        }
    }
    return out;
}

// simple non-stream LZ77 compressor (kept for compatibility) 
// naive implementation kept for API completeness (may be slower)
std::vector<LZ77Token> lz77_compress(const std::vector<uint8_t> &data, size_t windowSize, size_t maxMatch) {
    std::vector<LZ77Token> tokens;
    size_t n = data.size();
    size_t i = 0;

    const size_t MIN_MATCH = 3;
    while (i < n) {
        size_t bestLen = 0;
        size_t bestOffset = 0;
        size_t start = (i > windowSize) ? (i - windowSize) : 0;
        for (size_t j = start; j < i; ++j) {
            size_t k = 0;
            while (k < maxMatch && i + k < n && data[j + k] == data[i + k]) ++k;
            if (k > bestLen) {
                bestLen = k;
                bestOffset = i - j;
            }
        }
        if (bestLen >= MIN_MATCH) {
            if (bestOffset > 0xFFFF) bestOffset = 0xFFFF;
            if (bestLen > 0xFF) bestLen = 0xFF;
            LZ77Token t;
            t.offset = static_cast<uint16_t>(bestOffset);
            t.length = static_cast<uint8_t>(bestLen);
            t.lit = 0;
            tokens.push_back(t);
            i += bestLen;
        } else {
            LZ77Token t;
            t.offset = 0; t.length = 0; t.lit = data[i];
            tokens.push_back(t);
            ++i;
        }
    }
    return tokens;
}

// Streaming compressor class implementation 

inline uint32_t LZ77StreamCompressor::make_key(const uint8_t* p) {
    // pack 3 bytes into 24-bit key; safeguard if not enough bytes (caller ensures KEY_LEN usage)
    return (uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 8) | uint32_t(p[2]);
}

LZ77StreamCompressor::LZ77StreamCompressor(size_t w, size_t m)
    : windowSize(w), maxMatch(m), absolutePos(0) {
    dict.reserve(65536);
}

void LZ77StreamCompressor::feed(const std::vector<uint8_t>& chunk, bool isLast) {
    processChunk(chunk, isLast);
}

void LZ77StreamCompressor::processChunk(const std::vector<uint8_t>& chunk, bool /*isLast*/) {
    const size_t n = chunk.size();
    if (n == 0) return;

    const size_t MIN_MATCH = 3;
    const size_t KEY_LEN = 3;
    const size_t MAX_POS_PER_KEY = 64;

    size_t i = 0;
    while (i < n) {
        size_t bestLen = 0;
        size_t bestOffset = 0;

        if (i + KEY_LEN <= n && window.size() + (n - i) >= KEY_LEN) {
            // Build a temporary accessible buffer view that combines window tail and remaining chunk
            // For candidate matching we use positions stored relative to absolutePos.
            uint32_t key = make_key(&chunk[i]);
            auto it = dict.find(key);
            if (it != dict.end()) {
                auto& dq = it->second;
                size_t tries = 0;
                const size_t MAX_TRIES = 32;
                for (auto rit = dq.rbegin(); rit != dq.rend() && tries < MAX_TRIES; ++rit, ++tries) {
                    size_t j = *rit; // absolute position of candidate
                    size_t offset = absolutePos + i - j;
                    if (offset == 0 || offset > windowSize) continue;

                    // Compare bytes: we need to read from the window / chunk combined
                    size_t k = 0;
                    size_t limit = std::min(maxMatch, n - i);
                    while (k < limit) {
                        size_t posCandidate = j + k;
                        size_t posCurrent = absolutePos + i + k;
                        uint8_t candidateByte;
                        if (posCandidate < absolutePos) { // in older window (should not happen because we evict old positions)
                            break;
                        } else if (posCandidate < absolutePos + window.size()) {
                            candidateByte = window[posCandidate - absolutePos];
                        } else {
                            // candidate lies in already processed chunk area — safe to break early
                            break;
                        }

                        // current byte from chunk
                        uint8_t currentByte = chunk[i + k];
                        if (candidateByte != currentByte) break;
                        ++k;
                    }

                    if (k > bestLen) {
                        bestLen = k;
                        bestOffset = offset;
                        if (bestLen == maxMatch) break;
                    }
                }
            }
        }

        if (bestLen >= MIN_MATCH) {
            if (bestOffset > 0xFFFF) bestOffset = 0xFFFF;
            if (bestLen > 0xFF) bestLen = 0xFF;
            LZ77Token t{ static_cast<uint16_t>(bestOffset), static_cast<uint8_t>(bestLen), 0 };
            pendingTokens.push_back(t);

            // register matched positions
            size_t end = i + bestLen;
            for (size_t p = i; p < end; ++p) {
                if (absolutePos + p >= absolutePos) {
                    // register key at position absolutePos + p if possible
                    if (p + KEY_LEN <= n) {
                        uint32_t k = make_key(&chunk[p]);
                        auto &dq = dict[k];
                        dq.push_back(absolutePos + p);
                        if (dq.size() > MAX_POS_PER_KEY) dq.pop_front();
                    }
                }
            }
            i += bestLen;
        } else {
            // literal
            LZ77Token t{ 0, 0, chunk[i] };
            pendingTokens.push_back(t);

            if (i + KEY_LEN <= n) {
                uint32_t k = make_key(&chunk[i]);
                auto &dq = dict[k];
                dq.push_back(absolutePos + i);
                if (dq.size() > MAX_POS_PER_KEY) dq.pop_front();
            }
            ++i;
        }
    }

    // append chunk to sliding window
    for (uint8_t b : chunk) window.push_back(b);
    while (window.size() > windowSize) {
        // remove positions that move out of window: optional pruning of dict entries
        window.pop_front();
    }

    absolutePos += n;
}

std::vector<uint8_t> LZ77StreamCompressor::consumeOutput() {
    auto out = lz77_serialize(pendingTokens);
    pendingTokens.clear();
    return out;
}
