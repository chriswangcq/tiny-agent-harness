#!/usr/bin/env python3
"""
Thin wrapper around deepseek_v4_encoding.encode_messages().

Reads JSON from stdin:
  {
    "messages": [...],          # OpenAI chat format
    "thinking_mode": "thinking" # or "chat"
  }

Writes the encoded prompt string to stdout (no trailing newline).
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from deepseek_v4_encoding import encode_messages, merge_tool_messages

def main():
    data = json.load(sys.stdin)
    messages = data["messages"]
    thinking_mode = data.get("thinking_mode", "thinking")

    # Tools are passed on the first system message, not as a separate field.
    # The encode_messages function expects tools in OpenAI format on the message.

    encoded = encode_messages(
        messages=messages,
        thinking_mode=thinking_mode,
    )

    sys.stdout.write(encoded)

if __name__ == "__main__":
    main()
