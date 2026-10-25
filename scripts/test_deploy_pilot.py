"""Release boundary checks: a misleading or mixed app must never deploy."""
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('deploy_pilot', HERE/'deploy-pilot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def pilot():
    spec = json.loads((HERE.parent/'.do/pilot-app.json').read_text())
    values = {'LIFTY_RUNTIME_PROFILE':'connections','SUPABASE_URL':module.DATABASE,
      'PUBLIC_BASE_URL':module.BASE,'LIFTY_DASHBOARD_ORIGIN':'https://pilot.liftygtm.com',
      'UNIPILE_V2_APPLICATION_ID':'app_01m5fr5mgdfzx8ftceq7y7z0h4',
      'UNIPILE_V2_HOSTED_AUTH_ORIGINS':'https://auth.pilot.liftygtm.com'}
    spec['services'][0]['envs']=[{'key':key,'value':value} for key,value in values.items()]
    return spec


class PilotRelease(unittest.TestCase):
    def test_live_target_mismatch_stops_before_deployment(self):
        for field,value in [('branch','main'),('repo_clone_url','https://github.com/other/repo.git')]:
            with self.subTest(field=field):
                app=pilot(); app['services'][0]['git'][field]=value
                calls=[]
                def doctl(*args):
                    calls.append(args)
                    if args==('list',): return [{'id':'pilot-id','spec':app}]
                    self.fail('Release reached a mutation after a target mismatch')
                with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/develop','GITHUB_SHA':'a'*40,
                    'LIFTY_EMAIL_SERVER_KEY':'e'*40,'LIFTY_LINKEDIN_SERVER_KEY':'l'*40,'SUPABASE_PUBLISHABLE_KEY':'public'}), \
                    patch.object(module.subprocess,'check_output',return_value='a'*40+' refs/heads/develop'), \
                    patch.object(module,'probe',return_value={'version':'lifty.connection-profile.v1','sending_available':False}), \
                    patch.object(module,'doctl',side_effect=doctl):
                    with self.assertRaises(RuntimeError): module.main()
                self.assertEqual(calls,[('list',)])

    def test_missing_linkedin_database_capability_stops_before_provider_access(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/develop','GITHUB_SHA':'a'*40,
                'LIFTY_EMAIL_SERVER_KEY':'e'*40,'LIFTY_LINKEDIN_SERVER_KEY':'l'*40,'SUPABASE_PUBLISHABLE_KEY':'public'}), \
                patch.object(module.subprocess,'check_output',return_value='a'*40+' refs/heads/develop'), \
                patch.object(module,'probe',side_effect=HTTPError('https://staging.test',404,'Missing capability',{},None)) as probe, \
                patch.object(module,'doctl') as provider:
            with self.assertRaises(HTTPError): module.main()
            self.assertEqual(probe.call_args.args[1], {'p_server_key':'e'*40,'p_linkedin_server_key':'l'*40})
            provider.assert_not_called()

    def test_channel_capability_installs_in_one_deployment_preserving_existing_secrets(self):
        for already_configured in [False, True]:
            with self.subTest(already_configured=already_configured):
                live=pilot()
                live['services'][0]['envs'].append({'key':'UNIPILE_V2_ACCESS_TOKEN','value':'EV[encrypted-existing]','type':'SECRET','scope':'RUN_TIME'})
                if already_configured:
                    live['services'][0]['envs'].append({'key':'LIFTY_LINKEDIN_SERVER_KEY','value':'EV[encrypted-linkedin]','type':'SECRET','scope':'RUN_TIME'})
                original=json.loads(json.dumps(live))
                calls=[]
                def doctl(*args):
                    nonlocal live
                    calls.append(args[0])
                    app={'id':'pilot-id','spec':live,'active_deployment':{'id':'deployment-id'},'default_ingress':'https://pilot.test'}
                    if args==('list',): return [app]
                    if args[0]=='update':
                        # App spec updates otherwise reuse the previously deployed source.
                        self.assertIn('--update-sources', args)
                        path=Path(args[args.index('--spec')+1])
                        self.assertEqual(path.stat().st_mode & 0o077, 0)
                        updated=json.loads(path.read_text())
                        self.assertEqual(updated, {**original,'services':[{**original['services'][0],'envs':original['services'][0]['envs']+[
                            {'key':'LIFTY_LINKEDIN_SERVER_KEY','value':'l'*40,'type':'SECRET','scope':'RUN_TIME'}]}]})
                        live=updated
                        return [app]
                    if args[0]=='create-deployment': return [{}]
                    if args[0]=='get': return [app]
                    if args[0]=='get-deployment': return [{'id':'deployment-id','spec':live,'phase':'ACTIVE','services':[{'name':'api','source_commit_hash':'a'*40}]}]
                    self.fail('Unexpected provider operation')
                def probe(url, data=None, headers=None):
                    if '/rpc/' in url:
                        self.assertEqual(data,{'p_server_key':'e'*40,'p_linkedin_server_key':'l'*40})
                        return {'version':'lifty.connection-profile.v1','sending_available':False}
                    if url.endswith('/healthz'): return {'status':'ok'}
                    if url.endswith('/readyz'): return {'status':'ready'}
                    raise HTTPError(url,401,'Unauthenticated',{},None)
                with patch.dict(os.environ, {'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/develop','GITHUB_SHA':'a'*40,
                        'LIFTY_EMAIL_SERVER_KEY':'e'*40,'LIFTY_LINKEDIN_SERVER_KEY':'l'*40,'SUPABASE_PUBLISHABLE_KEY':'public'}), \
                        patch.object(module.subprocess,'check_output',return_value='a'*40+' refs/heads/develop'), \
                        patch.object(module,'probe',side_effect=probe), patch.object(module,'doctl',side_effect=doctl), \
                        patch('sys.stdout',new_callable=io.StringIO):
                    module.main()
                self.assertEqual([call for call in calls if call in ('update','create-deployment')],
                    ['create-deployment' if already_configured else 'update'])

    def test_production_credentials_or_target_cannot_enter_pilot(self):
        module.check_spec(pilot())
        for key,value in [('SUPABASE_URL','https://production.supabase.co'),('TRIGGER_SECRET_KEY','production-key')]:
            with self.subTest(key=key):
                app=pilot()
                app['services'][0]['envs']=[e for e in app['services'][0]['envs'] if e['key']!=key]+[{'key':key,'value':value}]
                with self.assertRaises(RuntimeError): module.check_spec(app)
        app=pilot();app['name']='lifty-api-staging'
        with self.assertRaises(RuntimeError): module.check_spec(app)


if __name__=='__main__': unittest.main()
