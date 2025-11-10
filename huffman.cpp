// huffman.cpp  (KP04-compatible; streaming compress + full decompressFile implementation)
#include "huffman.h"
#include "bitstream.h"
#include "kitty.h"
#include "lz77.h"
#include <iostream>
#include <bitset>
#include <iomanip>
#include <filesystem>
#include <algorithm>
#include <cstdint>
#include <sstream>
#include <array>
#include <cmath>

using namespace std;
namespace fs = std::filesystem;

void buildCodes(HuffmanNode* root, const string &str, unordered_map<unsigned char, string> &huffmanCode) {
    if (!root) return;
    if (!root->left && !root->right) {
        huffmanCode[root->ch] = (str.empty() ? "0" : str);
        return;
    }
    if (root->left) buildCodes(root->left, str + "0", huffmanCode);
    if (root->right) buildCodes(root->right, str + "1", huffmanCode);
}

void freeTree(HuffmanNode* root) {
    if (!root) return;
    freeTree(root->left);
    freeTree(root->right);
    delete root;
}

void storeRawFile(const string &inputPath, const string &outputPath) {
    ifstream in(inputPath, ios::binary);
    if (!in.is_open()) throw runtime_error("Cannot open input file.");

    vector<uint8_t> buffer((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
    in.close();

    ofstream out(outputPath, ios::binary);
    if (!out.is_open()) throw runtime_error("Cannot open output file for writing.");

    out.write(KITTY_MAGIC_V3.c_str(), KITTY_MAGIC_V3.size());
    bool isCompressed = false;
    out.write(reinterpret_cast<const char*>(&isCompressed), sizeof(isCompressed));

    string ext = filesystem::path(inputPath).extension().string();
    uint64_t extLen = ext.size();
    out.write(reinterpret_cast<const char*>(&extLen), sizeof(extLen));
    if (extLen > 0) out.write(ext.c_str(), extLen);

    uint64_t rawSize = buffer.size();
    out.write(reinterpret_cast<const char*>(&rawSize), sizeof(rawSize));
    if (rawSize > 0) out.write(reinterpret_cast<const char*>(buffer.data()), rawSize);

    out.close();
}

void restoreRawFile(std::ifstream &inStream, const string &outputPath) {
    uint64_t rawSize;
    inStream.read(reinterpret_cast<char*>(&rawSize), sizeof(rawSize));
    if (!inStream.good()) throw runtime_error("Failed to read raw size.");
    vector<char> buffer;
    buffer.resize(rawSize);
    if (rawSize > 0) {
        inStream.read(reinterpret_cast<char*>(buffer.data()), rawSize);
        if ((uint64_t)inStream.gcount() != rawSize) {
            throw runtime_error("Unexpected EOF while reading raw payload.");
        }
    }
    ofstream out(outputPath, ios::binary);
    if (!out.is_open()) throw runtime_error("Cannot open output file for writing.");
    if (rawSize > 0) out.write(buffer.data(), rawSize);
    out.close();
}

// compressFile: two-pass streamed approach (LZ77 streaming -> .lz77 tmp -> Huffman scan + encode)
void compressFile(const string &inputPath, const string &outputPath) {
    const size_t READ_CHUNK = 64 * 1024;
    const size_t ENTROPY_SAMPLE = 1024 * 1024; // 1 MiB
    const double ENTROPY_SKIP_THRESHOLD = 7.7; // bits/byte threshold to skip compression

    if (!fs::exists(inputPath)) throw runtime_error("Input not found.");

    ifstream in(inputPath, ios::binary);
    if (!in.is_open()) throw runtime_error("Cannot open input file.");

    // compute original size
    uint64_t originalSize = (uint64_t)fs::file_size(inputPath);

    // Smart-skip: quick entropy estimate on first up-to-ENTROPY_SAMPLE bytes 
    {
        size_t sampleLen = (size_t)min<uint64_t>(ENTROPY_SAMPLE, originalSize);
        if (sampleLen > 0) {
            vector<uint8_t> sample;
            sample.resize(sampleLen);
            in.read(reinterpret_cast<char*>(sample.data()), (std::streamsize)sampleLen);
            streamsize got = in.gcount();
            sample.resize((size_t)got);

            if (got > 0) {
                array<uint64_t, 256> freq = {};
                freq.fill(0);
                for (uint8_t b : sample) freq[b]++;

                double entropy = 0.0;
                const double N = (double)got;
                for (int i = 0; i < 256; ++i) {
                    if (freq[i] == 0) continue;
                    double p = (double)freq[i] / N;
                    entropy -= p * log2(p);
                }

                cout << fixed << setprecision(3);
                if (entropy >= ENTROPY_SKIP_THRESHOLD) {
                    cout << "\n⚡ Smart Skip: High-entropy file detected (H=" << entropy
                         << " bits/byte) — skipping compression and storing raw.\n";
                    in.close();
                    storeRawFile(inputPath, outputPath);
                    return;
                } else {
                    cout << "\nℹ️ Entropy check: H=" << entropy << " bits/byte — will attempt compression.\n";
                }
            }
            // rewind stream for normal processing
            in.clear();
            in.seekg(0, ios::beg);
        }
    }

    fs::path outPath(outputPath);
    fs::path tmpLzPath = outPath.string() + ".lz77.tmp";
    try { if (fs::exists(tmpLzPath)) fs::remove(tmpLzPath); } catch(...) {}

    ofstream lzOut(tmpLzPath, ios::binary);
    if (!lzOut.is_open()) { in.close(); throw runtime_error("Cannot open temporary LZ77 output file for writing."); }

    LZ77StreamCompressor lzstream;
    unordered_map<unsigned char, uint64_t> freq;

    // feed chunks
    vector<uint8_t> buf;
    buf.reserve(READ_CHUNK);
    while (true) {
        buf.clear();
        buf.resize(READ_CHUNK);
        in.read(reinterpret_cast<char*>(buf.data()), (std::streamsize)READ_CHUNK);
        streamsize got = in.gcount();
        if (got <= 0) break;
        buf.resize((size_t)got);
        lzstream.feed(buf, false);
        auto outBytes = lzstream.consumeOutput();
        if (!outBytes.empty()) {
            lzOut.write(reinterpret_cast<const char*>(outBytes.data()), outBytes.size());
            for (uint8_t b : outBytes) freq[static_cast<unsigned char>(b)]++;
        }
        if (got < (streamsize)READ_CHUNK) break;
    }

    // finalize
    lzstream.feed(vector<uint8_t>(), true);
    auto finalBytes = lzstream.consumeOutput();
    if (!finalBytes.empty()) {
        lzOut.write(reinterpret_cast<const char*>(finalBytes.data()), finalBytes.size());
        for (uint8_t b : finalBytes) freq[static_cast<unsigned char>(b)]++;
    }

    in.close();
    lzOut.flush();
    lzOut.close();

    if (freq.empty()) {
        try { fs::remove(tmpLzPath); } catch(...) {}
        storeRawFile(inputPath, outputPath);
        return;
    }

    // Build Huffman tree
    priority_queue<HuffmanNode*, vector<HuffmanNode*>, Compare> pq;
    for (auto &p : freq) pq.push(new HuffmanNode(p.first, (int)p.second));
    while (pq.size() > 1) {
        HuffmanNode *left = pq.top(); pq.pop();
        HuffmanNode *right = pq.top(); pq.pop();
        HuffmanNode *node = new HuffmanNode(0, left->freq + right->freq);
        node->left = left; node->right = right;
        pq.push(node);
    }
    HuffmanNode *root = pq.top();
    unordered_map<unsigned char, string> huffmanCode;
    buildCodes(root, "", huffmanCode);

    // Compute encoded length by scanning tmpLzPath
    uint64_t encodedLen = 0;
    {
        ifstream scan(tmpLzPath, ios::binary);
        if (!scan.is_open()) { freeTree(root); try { fs::remove(tmpLzPath); } catch(...) {} throw runtime_error("Failed to open temp LZ77 file for scanning."); }
        const size_t SCAN_BUF = 64 * 1024;
        vector<uint8_t> scanbuf;
        scanbuf.reserve(SCAN_BUF);
        while (true) {
            scanbuf.clear();
            scanbuf.resize(SCAN_BUF);
            scan.read(reinterpret_cast<char*>(scanbuf.data()), (std::streamsize)SCAN_BUF);
            streamsize got = scan.gcount();
            if (got <= 0) break;
            scanbuf.resize((size_t)got);
            for (uint8_t b : scanbuf) {
                auto it = huffmanCode.find(static_cast<unsigned char>(b));
                if (it == huffmanCode.end()) { freeTree(root); scan.close(); try { fs::remove(tmpLzPath); } catch(...) {} throw runtime_error("Huffman code missing for byte (unexpected)."); }
                encodedLen += it->second.size();
            }
            if (got < (streamsize)SCAN_BUF) break;
        }
        scan.close();
    }

    // Prepare encoded temp and write header + map
    fs::path tmpEncPath = outPath.string() + ".enc.tmp";
    try { if (fs::exists(tmpEncPath)) fs::remove(tmpEncPath); } catch(...) {}

    ofstream encOut(tmpEncPath, ios::binary);
    if (!encOut.is_open()) { freeTree(root); try { fs::remove(tmpLzPath); } catch(...) {} throw runtime_error("Cannot open temporary encoded output file for writing."); }

    encOut.write(KITTY_MAGIC_V3.c_str(), KITTY_MAGIC_V3.size());
    bool isCompressed = true;
    encOut.write(reinterpret_cast<const char*>(&isCompressed), sizeof(isCompressed));

    string ext = filesystem::path(inputPath).extension().string();
    uint64_t extLen = ext.size();
    encOut.write(reinterpret_cast<const char*>(&extLen), sizeof(extLen));
    if (extLen > 0) encOut.write(ext.c_str(), extLen);

    uint64_t mapSize = huffmanCode.size();
    encOut.write(reinterpret_cast<const char*>(&mapSize), sizeof(mapSize));
    for (auto &pair : huffmanCode) {
        unsigned char c = pair.first;
        const string &code = pair.second;
        uint64_t len = code.size();
        encOut.write(reinterpret_cast<const char*>(&c), sizeof(c));
        encOut.write(reinterpret_cast<const char*>(&len), sizeof(len));
        encOut.write(code.c_str(), len);
    }

    encOut.write(reinterpret_cast<const char*>(&encodedLen), sizeof(encodedLen));
    encOut.flush();

    // Read tmpLzPath and write codes
    {
        ifstream readLz(tmpLzPath, ios::binary);
        if (!readLz.is_open()) { freeTree(root); encOut.close(); try { fs::remove(tmpLzPath); } catch(...) {} try { fs::remove(tmpEncPath); } catch(...) {} throw runtime_error("Failed to open temp LZ77 file for second pass."); }
        BitWriter writer(encOut);
        const size_t PASS_BUF = 64 * 1024;
        vector<uint8_t> passbuf;
        passbuf.reserve(PASS_BUF);
        while (true) {
            passbuf.clear();
            passbuf.resize(PASS_BUF);
            readLz.read(reinterpret_cast<char*>(passbuf.data()), (std::streamsize)PASS_BUF);
            streamsize got = readLz.gcount();
            if (got <= 0) break;
            passbuf.resize((size_t)got);
            for (uint8_t b : passbuf) {
                const string &code = huffmanCode[static_cast<unsigned char>(b)];
                writer.writeBits(code);
            }
            if (got < (streamsize)PASS_BUF) break;
        }
        writer.flush();
        readLz.close();
    }

    encOut.flush();
    encOut.close();
    freeTree(root);

    // Compare sizes and keep encoded or fallback to raw
    size_t encodedSize = 0;
    try { encodedSize = (size_t)fs::file_size(tmpEncPath); } catch(...) { encodedSize = SIZE_MAX; }

    if (encodedSize < originalSize) {
        try { fs::rename(tmpEncPath, outputPath); } catch(...) {
            ifstream src(tmpEncPath, ios::binary);
            ofstream dst(outputPath, ios::binary);
            dst << src.rdbuf();
            src.close(); dst.close();
            try { fs::remove(tmpEncPath); } catch(...) {}
        }
        cout << "\n🐾 Smart Mode: Compression effective ("
             << fixed << setprecision(2)
             << 100.0 * (1.0 - (double)encodedSize / originalSize)
             << "% saved)\n";
        cout << "Final size: " << encodedSize << " bytes (original " << originalSize << ")\n";
        try { fs::remove(tmpLzPath); } catch(...) {}
    } else {
        try { fs::remove(tmpEncPath); } catch(...) {}
        try { fs::remove(tmpLzPath); } catch(...) {}
        cout << "\n⚡ Smart Mode: Compression skipped (file too compact)\n";
        storeRawFile(inputPath, outputPath);
    }
}

// decompressFile: full implementation (KP01, KP02, KP03)
void decompressFile(const string &inputPath, const string &outputPath) {
    ifstream in(inputPath, ios::binary);
    if (!in.is_open()) throw runtime_error("Cannot open input file.");

    string magic(4, '\0');
    in.read(&magic[0], 4);
    if (!in) throw runtime_error("Failed to read file signature.");

    // KP01 (old single-layer Huffman)
    if (magic == KITTY_MAGIC_V1) {
        uint64_t mapSize;
        in.read(reinterpret_cast<char*>(&mapSize), sizeof(mapSize));
        unordered_map<unsigned char, string> huffmanCode;
        for (uint64_t i = 0; i < mapSize; ++i) {
            unsigned char c; uint64_t len;
            in.read(reinterpret_cast<char*>(&c), sizeof(c));
            in.read(reinterpret_cast<char*>(&len), sizeof(len));
            string code(len, '\0');
            in.read(&code[0], len);
            huffmanCode[c] = code;
        }
        uint64_t encodedLen;
        in.read(reinterpret_cast<char*>(&encodedLen), sizeof(encodedLen));
        BitReader reader(in);
        bool bit;
        string bitstream; bitstream.reserve(encodedLen);
        while (reader.readBit(bit)) bitstream += (bit ? '1' : '0');
        in.close();
        if (bitstream.size() > encodedLen) bitstream.resize(encodedLen);
        unordered_map<string, unsigned char> reverseCode;
        for (auto &p : huffmanCode) reverseCode[p.second] = p.first;
        string current;
        vector<char> decoded;
        for (char b : bitstream) {
            current += b;
            auto it = reverseCode.find(current);
            if (it != reverseCode.end()) {
                decoded.push_back((char)it->second);
                current.clear();
            }
        }
        ofstream out(outputPath, ios::binary);
        if (!out.is_open()) throw runtime_error("Cannot open output file for writing.");
        if (!decoded.empty()) out.write(decoded.data(), decoded.size());
        out.close();
        cout << "Decompressed (KP01) successfully → " << outputPath << endl;
        return;
    }

    // KP02 (store or Huffman-on-bytes)
    if (magic == KITTY_MAGIC_V2) {
        bool isCompressed = false;
        in.read(reinterpret_cast<char*>(&isCompressed), sizeof(isCompressed));
        uint64_t extLen = 0; in.read(reinterpret_cast<char*>(&extLen), sizeof(extLen));
        if (extLen > 0) {
            string ext; ext.resize(extLen);
            in.read(&ext[0], extLen);
        }
        if (!isCompressed) {
            restoreRawFile(in, outputPath);
            in.close();
            cout << "Restored raw file (KP02) → " << outputPath << endl;
            return;
        }
        uint64_t mapSize;
        in.read(reinterpret_cast<char*>(&mapSize), sizeof(mapSize));
        unordered_map<unsigned char, string> huffmanCode;
        for (uint64_t i = 0; i < mapSize; ++i) {
            unsigned char c; uint64_t len;
            in.read(reinterpret_cast<char*>(&c), sizeof(c));
            in.read(reinterpret_cast<char*>(&len), sizeof(len));
            string code(len, '\0');
            in.read(&code[0], len);
            huffmanCode[c] = code;
        }
        uint64_t encodedLen; in.read(reinterpret_cast<char*>(&encodedLen), sizeof(encodedLen));
        BitReader reader(in);
        bool bit; string bitstream; bitstream.reserve(encodedLen);
        while (reader.readBit(bit)) bitstream += (bit ? '1' : '0');
        in.close();
        if (bitstream.size() > encodedLen) bitstream.resize(encodedLen);
        unordered_map<string, unsigned char> reverseCode;
        for (auto &p : huffmanCode) reverseCode[p.second] = p.first;
        string current; vector<char> decoded;
        for (char b : bitstream) {
            current += b;
            auto it = reverseCode.find(current);
            if (it != reverseCode.end()) {
                decoded.push_back((char)it->second);
                current.clear();
            }
        }
        ofstream out(outputPath, ios::binary);
        if (!out.is_open()) throw runtime_error("Cannot open output file for writing.");
        if (!decoded.empty()) out.write(decoded.data(), decoded.size());
        out.close();
        cout << "Decompressed (KP02) successfully → " << outputPath << endl;
        return;
    }

    // KP03 (LZ77 + Huffman)
    if (magic != KITTY_MAGIC_V3) {
        throw runtime_error("Unknown or corrupted .kitty file (bad signature).");
    }

    bool isCompressed = false;
    in.read(reinterpret_cast<char*>(&isCompressed), sizeof(isCompressed));
    uint64_t extLen = 0; in.read(reinterpret_cast<char*>(&extLen), sizeof(extLen));
    string ext;
    if (extLen > 0) {
        ext.resize(extLen);
        in.read(&ext[0], extLen);
    }

    if (!isCompressed) {
        restoreRawFile(in, outputPath);
        in.close();
        cout << "Restored raw file (KP03) → " << outputPath << endl;
        return;
    }

    // read Huffman map
    uint64_t mapSize = 0;
    in.read(reinterpret_cast<char*>(&mapSize), sizeof(mapSize));
    unordered_map<unsigned char, string> huffmanCode;
    for (uint64_t i = 0; i < mapSize; ++i) {
        unsigned char c; uint64_t len;
        in.read(reinterpret_cast<char*>(&c), sizeof(c));
        in.read(reinterpret_cast<char*>(&len), sizeof(len));
        string code(len, '\0');
        in.read(&code[0], len);
        huffmanCode[c] = code;
    }

    uint64_t encodedLen = 0;
    in.read(reinterpret_cast<char*>(&encodedLen), sizeof(encodedLen));

    // read Huffman bitstream into string of bits
    BitReader reader(in);
    bool bit; string bitstream; bitstream.reserve(encodedLen);
    while (reader.readBit(bit)) bitstream += (bit ? '1' : '0');
    in.close();
    if (bitstream.size() > encodedLen) bitstream.resize(encodedLen);

    // Decode to get serialized LZ77 bytes
    unordered_map<string, unsigned char> reverseCode;
    for (auto &p : huffmanCode) reverseCode[p.second] = p.first;
    string current;
    vector<uint8_t> tokenBytes;
    for (char b : bitstream) {
        current += b;
        auto it = reverseCode.find(current);
        if (it != reverseCode.end()) {
            tokenBytes.push_back(it->second);
            current.clear();
        }
    }

    // Deserialize tokens and LZ77-decompress
    auto tokens_out = lz77_deserialize(tokenBytes);
    auto original = lz77_decompress(tokens_out);

    ofstream out(outputPath, ios::binary);
    if (!out.is_open()) throw runtime_error("Cannot open output file for writing.");
    if (!original.empty()) out.write(reinterpret_cast<const char*>(original.data()), original.size());
    out.close();

    cout << "Decompressed (KP03) successfully → " << outputPath << endl;
}
