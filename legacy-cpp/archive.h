//archive.h
#pragma once
#include <string>
#include <vector>

struct ArchiveInput {
    std::string absPath;  // actual disk path
    std::string relPath;  // path inside archive
};

void createArchive(const std::vector<std::string>& inputs,
                   const std::string& outputArchive);

void extractArchive(const std::string& archivePath,
                    const std::string& outputFolder);
