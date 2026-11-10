//archive.cpp
#include "archive.h"
#include "huffman.h"
#include "kitty.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>
#include <cstdint>

using namespace std;
namespace fs = std::filesystem;

static void gatherFiles(const fs::path& base, const fs::path& p,
                        vector<ArchiveInput>& list) {
    if (fs::is_directory(p)) {
        for (auto& e : fs::recursive_directory_iterator(p))
            if (fs::is_regular_file(e.path()))
                list.push_back({ e.path().string(),
                                 fs::relative(e.path(), base).string() });
    } else if (fs::is_regular_file(p)) {
        list.push_back({ p.string(), p.filename().string() });
    }
}

void createArchive(const vector<string>& inputs, const string& outputArchive) {
    vector<ArchiveInput> files;
    for (auto& in : inputs)
        gatherFiles(fs::absolute(in).parent_path(), fs::absolute(in), files);

    ofstream out(outputArchive, ios::binary);
    if (!out) throw runtime_error("Cannot open output archive");

    // header
    out.write(KITTY_MAGIC_V4.c_str(), KITTY_MAGIC_V4.size());
    uint8_t ver = 4;
    out.write(reinterpret_cast<char*>(&ver), 1);
    uint32_t count = (uint32_t)files.size();
    out.write(reinterpret_cast<char*>(&count), 4);

    cout << "Creating archive with " << count << " file(s)\n";

    // stream entries
    for (auto& f : files) {
        ifstream in(f.absPath, ios::binary);
        if (!in) throw runtime_error("Cannot open input: " + f.absPath);

        vector<uint8_t> data((istreambuf_iterator<char>(in)),
                              istreambuf_iterator<char>());
        in.close();

        // compress to temporary file buffer using existing API
        string tmpOut = f.absPath + ".tmpkitty";
        compressFile(f.absPath, tmpOut);  // produces KP03 per file

        ifstream comp(tmpOut, ios::binary);
        vector<uint8_t> stored((istreambuf_iterator<char>(comp)),
                                istreambuf_iterator<char>());
        comp.close();
        fs::remove(tmpOut);

        bool isCompressed = true; // handled in compressFile
        uint16_t pathLen = (uint16_t)f.relPath.size();
        uint8_t flags = 1; // compressed flag
        uint64_t origSize = data.size();
        uint64_t dataSize = stored.size();

        out.write(reinterpret_cast<char*>(&pathLen), 2);
        out.write(f.relPath.c_str(), pathLen);
        out.write(reinterpret_cast<char*>(&flags), 1);
        out.write(reinterpret_cast<char*>(&origSize), 8);
        out.write(reinterpret_cast<char*>(&dataSize), 8);
        out.write(reinterpret_cast<char*>(stored.data()), dataSize);

        cout << "  + " << f.relPath << " (" << origSize << " → "
             << dataSize << ")\n";
    }

    out.close();
    cout << "Archive created: " << outputArchive << endl;
}

void extractArchive(const string& archivePath, const string& outputFolder) {
    ifstream in(archivePath, ios::binary);
    if (!in) throw runtime_error("Cannot open archive");

    string magic(4, '\0');
    in.read(&magic[0], 4);
    if (magic != KITTY_MAGIC_V4)
        throw runtime_error("Not a KP04 archive");

    uint8_t ver; in.read(reinterpret_cast<char*>(&ver), 1);
    uint32_t count; in.read(reinterpret_cast<char*>(&count), 4);

    cout << "Extracting " << count << " file(s)\n";

    for (uint32_t i = 0; i < count; ++i) {
        uint16_t pathLen; in.read(reinterpret_cast<char*>(&pathLen), 2);
        string rel(pathLen, '\0'); in.read(&rel[0], pathLen);
        uint8_t flags; in.read(reinterpret_cast<char*>(&flags), 1);
        uint64_t origSize, dataSize;
        in.read(reinterpret_cast<char*>(&origSize), 8);
        in.read(reinterpret_cast<char*>(&dataSize), 8);

        vector<uint8_t> buf(dataSize);
        in.read(reinterpret_cast<char*>(buf.data()), dataSize);

        fs::path outPath = fs::path(outputFolder) / rel;
        fs::create_directories(outPath.parent_path());

        // Write buffer to temp .kitty, then decompressFile()
        string tmp = outPath.string() + ".tmpkitty";
        ofstream tmpf(tmp, ios::binary);
        tmpf.write(reinterpret_cast<char*>(buf.data()), dataSize);
        tmpf.close();

        decompressFile(tmp, outPath.string());
        fs::remove(tmp);

        cout << "  Done " << rel << " (" << origSize << " bytes)\n";
    }

    in.close();
    cout << "Extraction finished → " << outputFolder << endl;
}
