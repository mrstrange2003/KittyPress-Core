@echo off
echo Building KittyPress v4 ...
echo.

:: Compile all sources with static linking
g++ main.cpp archive.cpp huffman.cpp lz77.cpp bitstream.cpp ^
    -std=c++17 -O2 -static -static-libstdc++ -static-libgcc -o kittypress.exe

IF %ERRORLEVEL% NEQ 0 (
    echo Build failed.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Build complete! -> kittypress.exe
echo KittyPress v4 is ready.
pause


:: How to use

:: 1. Put the file in the same folder as your .cpp and .h files.
:: 2. Just double-click build.bat (or run build in your terminal).
:: 3. If compilation succeeds, it’ll print:

::     Build complete! -> kittypress.exe
::     KittyPress v4 is ready.

:: If something goes wrong, it’ll pause so you can read the error.