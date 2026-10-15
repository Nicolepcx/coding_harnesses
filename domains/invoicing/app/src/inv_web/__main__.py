"""python -m inv_web DATA_FILE [PORT]"""
import sys
from wsgiref.simple_server import make_server, WSGIRequestHandler

from inv_web import make_app


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def main(argv):
    data = argv[1]
    port = int(argv[2]) if len(argv) > 2 else 8080
    server = make_server('127.0.0.1', port, make_app(data), handler_class=QuietHandler)
    print 'serving %s on http://127.0.0.1:%d' % (data, port)
    sys.stdout.flush()
    server.serve_forever()


if __name__ == '__main__':
    main(sys.argv)
