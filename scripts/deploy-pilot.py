#!/usr/bin/env python3
"""Deploy the isolated API from verified develop; never resolve the production app by its misleading name."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error

REPOSITORY = 'https://github.com/Lifty-Corp/lifty-api.git'
NAME = 'lifty-api-pilot'
BASE = 'https://api.pilot.liftygtm.com'
DATABASE = 'https://csyhcwpcojbjlwwxdmhc.supabase.co'


def doctl(*args):
    result = subprocess.run(['doctl','apps',*args,'-o','json'],capture_output=True,text=True)
    if result.returncode: raise RuntimeError('DigitalOcean operation failed: ' + args[0])
    return json.loads(result.stdout)


def check_spec(spec):
    if spec.get('name') != NAME or len(spec.get('services',[])) != 1 or any(spec.get(x) for x in ['workers','jobs','static_sites','functions']):
        raise RuntimeError('Unexpected pilot app structure')
    service = spec['services'][0]
    if service.get('name') != 'api' or service.get('git',{}).get('branch') != 'develop' or service.get('git',{}).get('repo_clone_url') != REPOSITORY:
        raise RuntimeError('Unexpected pilot source')
    values = {e['key']:e.get('value') for e in spec.get('envs',[]) + service.get('envs',[])}
    for key, value in {'LIFTY_RUNTIME_PROFILE':'connections','SUPABASE_URL':DATABASE,
        'PUBLIC_BASE_URL':BASE,'LIFTY_DASHBOARD_ORIGIN':'https://pilot.liftygtm.com',
        'UNIPILE_V2_APPLICATION_ID':'app_01m5fr5mgdfzx8ftceq7y7z0h4',
        'UNIPILE_V2_HOSTED_AUTH_ORIGINS':'https://auth.pilot.liftygtm.com'}.items():
        if values.get(key) != value: raise RuntimeError('Pilot target mismatch: ' + key)
    allowed = {'LIFTY_RUNTIME_PROFILE','SUPABASE_URL','SUPABASE_JWKS_URL','SUPABASE_PUBLISHABLE_KEY',
        'PUBLIC_BASE_URL','LIFTY_DASHBOARD_ORIGIN','UNIPILE_V2_APPLICATION_ID','UNIPILE_V2_HOSTED_AUTH_ORIGINS',
        'LIFTY_EMAIL_SERVER_KEY','UNIPILE_V2_ACCESS_TOKEN'}
    if set(values)-allowed: raise RuntimeError('Unexpected pilot environment setting')
    if service.get('instance_size_slug') != 'apps-s-1vcpu-0.5gb' or service.get('instance_count') != 1:
        raise RuntimeError('Unexpected pilot size')


def probe(url, data=None, headers=None):
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
        headers=headers or {}, method='GET' if data is None else 'POST')
    with urllib.request.urlopen(request,timeout=15) as response: return json.load(response)


def main():
    sha = os.environ.get('GITHUB_SHA','')
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_REF') != 'refs/heads/develop' or len(sha) != 40:
        raise RuntimeError('Pilot deployment belongs to verified develop CI')
    remote = subprocess.check_output(['git','ls-remote',REPOSITORY,'refs/heads/develop'],text=True).split()[0]
    if remote != sha: raise RuntimeError('Superseded develop source')
    ready = probe(DATABASE+'/rest/v1/rpc/lifty_connection_profile_ready',
        {'p_server_key':os.environ['LIFTY_EMAIL_SERVER_KEY']},
        {'apikey':os.environ['SUPABASE_PUBLISHABLE_KEY'],'Content-Type':'application/json'})
    if ready.get('version') != 'lifty.connection-profile.v1' or ready.get('sending_available') is not False:
        raise RuntimeError('Staging database and replay are not ready')
    apps = [app for app in doctl('list') if app['spec']['name'] == NAME]
    if len(apps)>1: raise RuntimeError('Ambiguous pilot app')
    if not apps:
        # Creation performs the initial deployment; do not create another one.
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch)/'pilot.json'
            result = subprocess.run(['node','scripts/prepare-pilot.mjs','--output',str(path)],capture_output=True)
            if result.returncode: raise RuntimeError('Pilot spec preparation failed')
            check_spec(json.loads(path.read_text()))
            app = doctl('create','--spec',str(path),'--wait')[0]
            app = doctl('get',app['id'])[0]
    else:
        app = apps[0]
        check_spec(app['spec'])
        if os.environ.get('LIFTY_PILOT_APP_ID') and app['id'] != os.environ['LIFTY_PILOT_APP_ID']:
            raise RuntimeError('Unexpected pilot app ID')
        doctl('create-deployment',app['id'],'--wait')
        app = doctl('get',app['id'])[0]
    deployment = doctl('get-deployment',app['id'],app['active_deployment']['id'])[0]
    check_spec(deployment['spec'])
    sources = [x.get('source_commit_hash') for x in deployment.get('services',[]) if x['name']=='api']
    if deployment.get('phase') != 'ACTIVE' or sources != [sha]: raise RuntimeError('Active pilot source differs from develop')
    ingress = app['default_ingress'].rstrip('/')
    if probe(ingress+'/healthz').get('status') != 'ok' or probe(ingress+'/readyz').get('status') != 'ready':
        raise RuntimeError('Pilot health/readiness failed')
    try:
        probe(ingress+'/v1/workspace')
    except urllib.error.HTTPError as error:
        if error.code != 401: raise RuntimeError('Pilot authentication boundary failed')
    else: raise RuntimeError('Unauthenticated pilot workspace was accessible')
    print(json.dumps({'app_id':app['id'],'deployment_id':deployment['id'],'source':sha,'ingress':ingress,'ready':True}))


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, RuntimeError) as error:
        # HTTP/provider bodies and private specs never enter CI logs.
        message = str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('Pilot deployment failed: ' + message, file=sys.stderr)
        sys.exit(1)
