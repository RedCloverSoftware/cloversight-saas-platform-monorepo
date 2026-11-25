import runpy
from pathlib import Path
import yaml

class Loader(yaml.SafeLoader): pass
def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode): data = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode): data = loader.construct_sequence(node)
    else: data = loader.construct_mapping(node)
    return {tag: data}
Loader.add_multi_constructor('!', intrinsic)
template = yaml.load(Path('infra/cloudformation/webwatch.yaml').read_text(), Loader=Loader)
resources = template['Resources']
conditions = template['Conditions']
def resolve(node, mode):
    if isinstance(node, list): return [resolve(x, mode) for x in node]
    if not isinstance(node, dict): return node
    op, args = next(iter(node.items()))
    if op == 'Ref': return {'CustomerCognitoDomainMode': mode}[args]
    if op == 'Condition': return resolve(conditions[args], mode)
    if op == 'Equals':
        a, b = resolve(args, mode)
        return a == b
    if op == 'Or': return any(resolve(args, mode))
    raise ValueError(op)

items = ['CustomerUserPoolDomain', 'CustomerUserPoolCustomDomain', 'CustomerManagedLoginBranding', 'CustomerCustomManagedLoginBranding']
for mode, expected in {'prefix': [1,0,1,0], 'custom': [0,1,0,1], 'custom-with-prefix': [1,1,1,0], 'none': [0,0,0,0]}.items():
    assert [resolve(conditions[resources[r]['Condition']], mode) for r in items] == expected
    assert resolve(conditions['UseCustomerCustomDomain'], mode) == bool(expected[1])
assert template['Outputs']['CustomerCognitoDomain']['Value']['If'][0] == 'UseCustomerCustomDomain'
assert resources['CustomerCognitoDnsA']['Properties']['AliasTarget']['DNSName'] == {'GetAtt':'CustomerUserPoolCustomDomain.CloudFrontDistribution'}
helper = runpy.run_path('scripts/plan-production-login.py')
for mode, desired in [('prefix','custom-with-prefix'), ('custom','custom'), ('custom-with-prefix','custom-with-prefix'), ('none','custom')]:
    original = {'CustomerCognitoDomainMode': mode, 'CustomerCognitoCertificateArn': 'cert', 'CognitoEmailDelivery': 'cognito', 'RuntimeArtifactKey': 'installed', 'WorkerImageUri': 'installed'}
    params = {x['ParameterKey']: x for x in helper['plan_parameters'](original, 'cert')}
    assert params['CustomerCognitoDomainMode'].get('ParameterValue', mode) == desired
    assert params['CognitoEmailDelivery']['ParameterValue'] == 'ses'
    assert all(params[key]['UsePreviousValue'] for key in ['RuntimeArtifactKey','WorkerImageUri','CustomerCognitoCertificateArn'])
partial = {p['ParameterKey']:p for p in helper['plan_parameters'](original, None, 'email')}
assert partial['CustomerCognitoDomainMode']['UsePreviousValue'] and partial['CustomerCognitoCertificateArn']['UsePreviousValue']
partial = {p['ParameterKey']:p for p in helper['plan_parameters'](original, 'cert', 'domain')}
assert partial['CognitoEmailDelivery']['UsePreviousValue']
assert helper['covers']('*.cloversight.app','auth.cloversight.app')
assert not helper['covers']('*.cloversight.app','auth.staging.cloversight.app')
