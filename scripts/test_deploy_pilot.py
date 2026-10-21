"""Release boundary checks: a misleading or mixed app must never deploy."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

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
                    'LIFTY_EMAIL_SERVER_KEY':'key','SUPABASE_PUBLISHABLE_KEY':'public'}), \
                    patch.object(module.subprocess,'check_output',return_value='a'*40+' refs/heads/develop'), \
                    patch.object(module,'probe',return_value={'version':'lifty.connection-profile.v1','sending_available':False}), \
                    patch.object(module,'doctl',side_effect=doctl):
                    with self.assertRaises(RuntimeError): module.main()
                self.assertEqual(calls,[('list',)])

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
