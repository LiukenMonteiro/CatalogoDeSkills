#!/usr/bin/env python3
"""Libera a gravação na pasta de skills para navegadores isolados (snap ou flatpak) no Linux.

Quando você escolhe uma pasta num navegador instalado como snap ou flatpak, o portal de
documentos do sistema entrega essa pasta ao navegador só para leitura. Por isso o Catálogo
de Skills não consegue instalar com um clique. Este script dá a permissão de escrita ao
documento dessa pasta no portal. Não altera mais nada.

Passo a passo:
  1. No site, clique em Instalar e escolha a pasta ~/.claude/skills (a falha é esperada).
  2. Rode este script sem argumentos para ver o que ele faria:
       python3 scripts/liberar-gravacao-linux.py
  3. Se estiver certo, aplique:
       python3 scripts/liberar-gravacao-linux.py --aplicar
  4. Volte ao site e instale de novo.

Só mexe em pastas dentro de ~/.claude. Para desfazer, escolha a pasta de novo ou use
org.freedesktop.portal.Documents.RevokePermissions (veja o README).
"""
import argparse
import codecs
import os
import re
import subprocess
import sys

STORE = ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.impl.portal.PermissionStore',
         '--object-path', '/org/freedesktop/impl/portal/PermissionStore', '--method']
DOCS = ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.portal.Documents',
        '--object-path', '/org/freedesktop/portal/documents', '--method']


def gdbus(base, method, *args):
    try:
        r = subprocess.run([*base, method, *args], capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        sys.exit('Não encontrei o comando gdbus. No Ubuntu/Debian ele vem no pacote libglib2.0-bin.')
    if r.returncode != 0:
        sys.exit(f'O sistema recusou: {(r.stderr or r.stdout).strip()}')
    return r.stdout


def lookup(doc_id):
    """Devolve (caminho, {app: [permissões]}) de um documento do portal."""
    out = gdbus(STORE, 'org.freedesktop.impl.portal.PermissionStore.Lookup', 'documents', doc_id)
    m = re.search(r"b'((?:[^'\\]|\\.)*)'", out)
    if not m:
        return None, {}
    path = codecs.escape_decode(m.group(1).encode())[0].decode('utf-8', 'replace')
    apps = {a: re.findall(r"'([^']+)'", perms) for a, perms in re.findall(r"'([^']+)': \[([^\]]*)\]", out.split('}, <')[0])}
    return path, apps


def main():
    ap = argparse.ArgumentParser(description='Libera a gravação na pasta de skills para navegadores snap/flatpak.')
    ap.add_argument('--aplicar', action='store_true', help='concede a escrita (sem isto, só mostra o que faria)')
    ap.add_argument('--pasta', default='~/.claude/skills', help='pasta a liberar (padrão: ~/.claude/skills)')
    args = ap.parse_args()

    claude = os.path.realpath(os.path.expanduser('~/.claude'))
    alvo = os.path.realpath(os.path.expanduser(args.pasta))
    if alvo != claude and not alvo.startswith(claude + os.sep):
        sys.exit(f'Por segurança, só mexo em pastas dentro de {claude}.')

    ids = re.findall(r"'([0-9a-f]+)'", gdbus(STORE, 'org.freedesktop.impl.portal.PermissionStore.List', 'documents'))
    pendentes, ja_ok = [], []
    for doc in ids:
        path, apps = lookup(doc)
        if path != alvo:
            continue
        for app, perms in apps.items():
            (ja_ok if 'write' in perms else pendentes).append((doc, app))

    print(f'Pasta: {alvo}')
    if alvo == claude:
        print('Atenção: esta é a pasta .claude inteira (inclui credenciais e configurações). Prefira só a pasta skills.')
    for doc, app in ja_ok:
        print(f'  já pode gravar: {app} (documento {doc})')
    if not pendentes:
        if not ja_ok:
            print('Nenhum navegador escolheu essa pasta ainda. No site, clique em Instalar e escolha a pasta; depois rode este script de novo.')
        else:
            print('Nada a fazer.')
        return
    for doc, app in pendentes:
        print(f'  só leitura: {app} (documento {doc})')
    if not args.aplicar:
        print('\nNada foi alterado. Para conceder a escrita a esses aplicativos, rode de novo com --aplicar.')
        return
    for doc, app in pendentes:
        gdbus(DOCS, 'org.freedesktop.portal.Documents.GrantPermissions', doc, app, "['read','write']")
        _, apps = lookup(doc)
        print(f'  liberado: {app} agora tem {", ".join(apps.get(app, []))}')
    print('\nPronto. Volte ao site e instale de novo.')


if __name__ == '__main__':
    main()
