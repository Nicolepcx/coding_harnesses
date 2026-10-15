"""Tiny object store in the spirit of ZODB: a pickled root mapping on disk."""
import os
import cPickle

PROTOCOL = 2


class Persistent(object):
    """Base class for stored objects. Attributes starting with _v_ are volatile."""

    def __getstate__(self):
        state = {}
        for k, v in self.__dict__.iteritems():
            if not k.startswith('_v_'):
                state[k] = v
        return state

    def __setstate__(self, state):
        self.__dict__.update(state)


class FileStorage(object):

    def __init__(self, path):
        self.path = path

    def load(self):
        if not os.path.exists(self.path):
            return {}
        f = open(self.path, 'rb')
        try:
            return cPickle.load(f)
        finally:
            f.close()

    def save(self, root):
        tmp = self.path + '.tmp'
        f = open(tmp, 'wb')
        try:
            cPickle.dump(root, f, PROTOCOL)
        finally:
            f.close()
        os.rename(tmp, self.path)


def open_root(path):
    return FileStorage(path).load()
