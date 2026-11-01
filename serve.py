#!/usr/bin/env python3
"""Static file server for local development.

Serves this folder and tells the browser not to cache anything, so edits to the JS modules
show up on a normal reload. It listens on all network interfaces, so a phone on the same network
can open one of the printed LAN addresses. Usage: python3 serve.py [port]
"""
import os
import socket
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def is_usable(address):
    return address.count('.') == 3 and not address.startswith(('127.', '169.254.'))


def lan_addresses():
    """Every IPv4 address of this computer that other devices could reach it at (ethernet, Wi-Fi, ...)."""
    found = []
    try:
        output = subprocess.run(['hostname', '-I'], capture_output=True, text=True, timeout=3).stdout
        found = [a for a in output.split() if is_usable(a)]
    except (OSError, subprocess.SubprocessError):
        pass
    if not found:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(('10.255.255.255', 1))  # no packet is sent; this only selects the outgoing interface
            if is_usable(probe.getsockname()[0]):
                found = [probe.getsockname()[0]]
        except OSError:
            pass
        finally:
            probe.close()
    return found


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'On this computer:  http://localhost:{port}')
    addresses = lan_addresses()
    for address in addresses:
        print(f'On a phone:        http://{address}:{port}')
    if len(addresses) > 1:
        print('Several addresses are listed (for example ethernet and Wi-Fi). Use the one whose first three')
        print('numbers match the phone\'s Wi-Fi address, e.g. both start with 192.168.1.')
    print('Stop with Ctrl+C.')
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
