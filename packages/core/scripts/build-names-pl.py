"""Packs the PESEL name lists (living persons) into one sorted text file for binary search.

Sections, each sorted by the UTF-8 bytes of the key:
  F  first names:  NAME <tab> men <tab> women
  L  surnames:     NAME <tab> men <tab> women
  f  first names written without diacritics: FOLDED <tab> men <tab> women  (sum over the listed names that fold to it and differ from it)
  l  the same for surnames
An empty count means zero.
"""
import csv, gzip, sys, unicodedata, collections, io

src, out, edition = sys.argv[1], sys.argv[2], sys.argv[3]
EXTRA = {'Ł': 'L', 'Ø': 'O', 'Đ': 'D', 'Ð': 'D', 'Þ': 'TH', 'Æ': 'AE', 'ẞ': 'SS', 'Ɖ': 'D', 'Ƚ': 'L', 'Ɠ': 'G', 'Œ': 'OE'}

def fold(s):
    s = ''.join(c for c in unicodedata.normalize('NFD', s) if not ('̀' <= c <= 'ͯ'))
    return ''.join(EXTRA.get(c, c) for c in s)

def read(name):
    m = collections.Counter()
    for r in list(csv.reader(open(f'{src}/{name}.csv', encoding='utf-8-sig')))[1:]:
        key = unicodedata.normalize('NFC', ' '.join(r[0].upper().split()))
        if key and r[-1].isdigit():
            m[key] += int(r[-1])
    return m

def section(tag, men, women):
    names = sorted(set(men) | set(women), key=lambda s: s.encode('utf-8'))
    lines = [f"{n}\t{men.get(n) or ''}\t{women.get(n) or ''}" for n in names]
    fm, ff = collections.Counter(), collections.Counter()
    for n in names:
        k = fold(n)
        if k != n:
            fm[k] += men.get(n, 0)
            ff[k] += women.get(n, 0)
    folded = sorted(set(fm) | set(ff), key=lambda s: s.encode('utf-8'))
    flines = [f"{k}\t{fm.get(k) or ''}\t{ff.get(k) or ''}" for k in folded]
    return (tag, lines), (tag.lower(), flines)

first_m, first_f, last_m, last_f = read('first-m'), read('first-f'), read('surnames-m'), read('surnames-f')
parts = [*section('F', first_m, first_f), *section('L', last_m, last_f)]
buf = io.StringIO()
buf.write(f"#edition\t{edition}\n#men\t{sum(first_m.values())}\n#women\t{sum(first_f.values())}\n")
for tag, lines in parts:
    buf.write(f"#section\t{tag}\t{len(lines)}\n")
    buf.write('\n'.join(lines) + '\n')
raw = buf.getvalue().encode('utf-8')
with open(out, 'wb') as fh:
    with gzip.GzipFile(filename='', mode='wb', fileobj=fh, compresslevel=9, mtime=0) as gz:
        gz.write(raw)
print('raw bytes', len(raw), {tag: len(lines) for tag, lines in parts}, 'men', sum(first_m.values()), 'women', sum(first_f.values()))
