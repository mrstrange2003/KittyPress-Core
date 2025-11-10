// main.cpp
#include <iostream>
#include <string>
#include <filesystem>
#include "huffman.h"
#include "archive.h"

using namespace std;
namespace fs = std::filesystem;

void printUsage() {
    cout << "\nKittyPress v4 " << endl;
    cout << "Universal lossless archiver using LZ77 + Huffman (multi-file supported)\n\n";
    cout << "Usage:\n"
         << "  kittypress compress <input1> [<input2> ...] <output.kitty>\n"
         << "  kittypress decompress <archive.kitty> <outputFolder>\n";
}

int main(int argc, char* argv[]) {
    cout << "KittyPress launched! argc=" << argc << endl;
    if (argc < 3) { printUsage(); return 1; }

    string mode = argv[1];

    try {
        if (mode == "compress") {
            if (argc < 4) { printUsage(); return 1; }
            vector<string> inputs;
            for (int i = 2; i < argc - 1; ++i)
                inputs.push_back(argv[i]);
            string output = argv[argc - 1];

            createArchive(inputs, output);
        }
        else if (mode == "decompress") {
            if (argc < 4) { printUsage(); return 1; }
            string archive = argv[2];
            string folder  = argv[3];
            extractArchive(archive, folder);
        }
        else {
            printUsage();
            return 1;
        }
    } catch (const exception& e) {
        cerr << "Error: " << e.what() << endl;
        return 1;
    }

    cout << "[KittyPress] Done.\n";
    return 0;
}

