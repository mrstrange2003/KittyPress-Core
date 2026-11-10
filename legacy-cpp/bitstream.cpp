// bitstream.cpp
#include "bitstream.h"
#include <iostream>

BitWriter::BitWriter(std::ostream &stream) : out(stream), buffer(0), bitCount(0) {}

void BitWriter::writeBit(bool bit) {
    buffer = (buffer << 1) | (bit ? 1 : 0);
    bitCount++;
    if (bitCount == 8) {
        out.write(reinterpret_cast<const char*>(&buffer), 1);
        bitCount = 0;
        buffer = 0;
    }
}

void BitWriter::writeBits(const std::string &bits) {
    for (char c : bits) writeBit(c == '1');
}

void BitWriter::flush() {
    if (bitCount > 0) {
        buffer <<= (8 - bitCount);
        out.write(reinterpret_cast<const char*>(&buffer), 1);
        bitCount = 0;
        buffer = 0;
    }
}

//BitReader

BitReader::BitReader(std::istream &stream) : in(stream), buffer(0), bitCount(0) {}

bool BitReader::readBit(bool &bit) {
    if (bitCount == 0) {
        if (!in.read(reinterpret_cast<char*>(&buffer), 1))
            return false;
        bitCount = 8;
    }
    // Read MSB first
    bit = (buffer & 0x80) != 0;
    buffer <<= 1;
    bitCount--;
    return true;
}
