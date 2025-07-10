#!/bin/bash


# Install the extension
code --install-extension $(ls *.vsix | head -n 1)

if [ $? -eq 0 ]; then
    echo "Extension installed successfully"
else
    echo "Extension installation failed"
fi

