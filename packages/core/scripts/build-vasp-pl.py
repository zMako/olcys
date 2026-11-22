"""Turns the rows read from the published register into the bundled JSON file."""
import json, re, sys

rows = [r['cells'] for r in json.load(open(sys.argv[1]))]
SERVICES = [
    ('a', 'wymiana pomiędzy walutami wirtualnymi i środkami płatniczymi'),
    ('b', 'wymiana pomiędzy walutami wirtualnymi'),
    ('c', 'pośrednictwo w wymianie, o której mowa w lit. a lub b'),
    ('d', 'prowadzenie rachunków, o których mowa w ust. 2 pkt 17 lit. e'),
]
COMPANY = re.compile(r'SPÓŁKA|FUNDACJA|STOWARZYSZENIE|SP\. Z O\.O|S\.R\.O|OSAÜHING|SOCIEDAD LIMITADA|BESLOTEN VENNOOTSCHAP|(?<![-\w])(OÜ|OU|LTD|LIMITED|UAB|GMBH|LLC|INC|SAS|AS|SIA|AG|SRL|LLP|CORP|S\.A\.|S\.L\.|B\.V\.)\.?$', re.I)

def iso(d):
    m = re.fullmatch(r'(\d{1,2})\.(\d{2})\.(\d{4})', d)
    return f"{m.group(3)}-{m.group(2)}-{int(m.group(1)):02d}" if m else None

entries = []
for number, entered, name, krs, nip, services, suspended, ended in rows:
    rest, letters = services, ''
    for letter, text in SERVICES:
        if text in rest:
            letters += letter
            rest = rest.replace(text, '', 1)
    assert not rest.strip(), (number, rest)
    assert ended in ('---', 'wykreślony'), (number, ended)
    e = {'number': number, 'entered': iso(entered), 'name': name, 'kind': 'company' if (krs != '---' or COMPANY.search(name)) else 'person', 'nip': nip, 'services': letters}
    if krs != '---':
        e['krs'] = krs
    if suspended != '---':
        e['suspendedFrom'] = iso(suspended)
    if ended != '---':
        e['struckOff'] = True
    entries.append(e)
entries.sort(key=lambda e: int(e['number'].split('-')[1]))
out = {
    'register': 'Rejestr działalności w zakresie walut wirtualnych',
    'keptBy': 'Dyrektor Izby Administracji Skarbowej w Katowicach',
    'edition': '2026-07-02',
    'status': 'Wersja archiwalna rejestru, stan na 2 lipca 2026 r. Według informacji organu prowadzącego wpis do rejestru nie uprawnia do świadczenia usług w zakresie kryptoaktywów; usługi te wymagają zezwolenia wydanego na podstawie rozporządzenia MiCA.',
    'sourcePage': 'https://www.gov.pl/web/ias-katowice/rejestr-dzialalnosci-w-zakresie-walut-wirtualnych',
    'sourceFile': 'https://www.gov.pl/attachment/8756421f-bfab-4404-8448-2ca7954ffbb9',
    'sourceFileName': 'Wersja_archiwalna_Rejestru_Działalności_w_zakresie_walut_wirtualnych_-_stan_na_2072026r.pdf',
    'retrieved': sys.argv[3],
    'services': {letter: text for letter, text in SERVICES},
    'entries': entries,
}
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    fh.write('{\n')
    for k, v in out.items():
        if k != 'entries':
            fh.write(f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n')
    fh.write('  "entries": [\n')
    fh.write(',\n'.join('    ' + json.dumps(e, ensure_ascii=False, separators=(',', ':')) for e in entries))
    fh.write('\n  ]\n}\n')
import collections
print(len(entries), collections.Counter(e['kind'] for e in entries), 'struck off', sum(1 for e in entries if e.get('struckOff')), 'suspended', sum(1 for e in entries if e.get('suspendedFrom')), 'with KRS', sum(1 for e in entries if e.get('krs')))
print([e['name'] for e in entries if e['kind'] == 'person'][:12])
print([e['name'] for e in entries if e['kind'] == 'company' and 'krs' not in e][:30])
