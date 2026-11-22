"""Reads the published register (a PDF table with a watermark) into rows.
The table text is set in Roboto; the watermark and the notice above the table are in another typeface, so they are dropped by font."""
import sys, json, re, pdfplumber

pdf = pdfplumber.open(sys.argv[1])
entries, loose = [], 0
for n, page in enumerate(pdf.pages):
    clean = page.filter(lambda o: o.get('object_type') != 'char' or 'Roboto' in o.get('fontname', ''))
    for table in clean.extract_tables():
        for row in table:
            cells = [' '.join((c or '').split()) for c in row]
            if len(cells) != 8 or cells[0].startswith('Numer'):
                continue
            if re.fullmatch(r'RDWW-\d+', cells[0]):
                entries.append({'page': n + 1, 'cells': cells})
            elif entries and any(cells):
                # a row continued on the next page
                prev = entries[-1]['cells']
                for i, c in enumerate(cells):
                    if c:
                        prev[i] = (prev[i] + ' ' + c).strip()
            else:
                loose += 1
json.dump(entries, open(sys.argv[2], 'w'), ensure_ascii=False)
print('pages', len(pdf.pages), 'entries', len(entries), 'loose rows', loose)
