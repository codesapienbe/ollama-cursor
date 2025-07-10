#!/bin/bash


# Install the extension
code --install-extension $(ls *.vsix | head -n 1)

if ! [ $? -eq 0 ]; then
    echo "Extension installation failed"
    echo "Please install the extension manually"
    echo "1. Open the Extensions view"
    echo "2. Click on the ... button"
    echo "3. Select 'Install from VSIX'"
    echo "4. Select the downloaded VSIX file"
    echo "5. Click 'Install'"
    exit 1
fi

