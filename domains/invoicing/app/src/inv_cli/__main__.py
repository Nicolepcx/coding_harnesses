"""python -m inv_cli COMMAND DATA_FILE [ARGS...]"""
import sys

from inv_cli import COMMANDS


def main(argv):
    if len(argv) < 3 or argv[1] not in COMMANDS:
        print >> sys.stderr, 'usage: inv_cli {%s} DATA_FILE [ARGS...]' % ','.join(sorted(COMMANDS))
        return 2
    COMMANDS[argv[1]](argv[2], *argv[3:])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
