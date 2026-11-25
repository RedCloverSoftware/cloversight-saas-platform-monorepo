"""Inspect the current production login or prepare a configuration-only CFN change set."""
import argparse
import json
import os
import socket
import subprocess
import sys
import time

REGION = "us-east-1"
DOMAIN = "cloversight.app"
AUTH = f"auth.{DOMAIN}"


def aws(*args):
    result = subprocess.run(["aws", "--region", REGION, "--no-cli-pager", *args, "--output", "json"],
                            text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def domain_info(host):
    try:
        return aws("cognito-idp", "describe-user-pool-domain", "--domain", host).get("DomainDescription", {})
    except RuntimeError as exc:
        if "(ResourceNotFoundException)" in str(exc):
            return {}
        raise


def plan_parameters(previous, certificate, scope="both"):
    if "CognitoEmailDelivery" not in previous:
        raise ValueError("Deploy the patched template through the business main workflow first.")
    wanted = {}
    if scope in {"both", "domain"}:
        mode = previous["CustomerCognitoDomainMode"]
        if mode not in {"prefix", "custom", "custom-with-prefix", "none"}:
            raise ValueError(f"Unknown installed customer login mode {mode!r}.")
        wanted["CustomerCognitoDomainMode"] = "custom-with-prefix" if mode in {"prefix", "custom-with-prefix"} else "custom"
        wanted["CustomerCognitoCertificateArn"] = certificate
    if scope in {"both", "email"}:
        wanted["CognitoEmailDelivery"] = "ses"
    parameters = []
    for key, value in previous.items():
        entry = {"ParameterKey": key}
        if key in wanted and value != wanted[key]:
            entry["ParameterValue"] = wanted[key]
        else:
            entry["UsePreviousValue"] = True
        parameters.append(entry)
    return parameters


def covers(name, host):
    return name == host or (name.startswith("*.") and host.partition(".")[2] == name[2:])


def inspect_domain(stack, params, out, validate):
    zone = params["HostedZoneId"]
    zone_info = aws("route53", "get-hosted-zone", "--id", zone)
    hosted = zone_info["HostedZone"]
    records = aws("route53", "list-resource-record-sets", "--hosted-zone-id", zone)["ResourceRecordSets"]
    dns = [r for r in records if r["Name"].rstrip(".").lower() in {DOMAIN, AUTH} and r["Type"] in {"A", "AAAA", "CNAME"}]
    cert_arn = os.environ.get("COGNITO_CUSTOMER_CERTIFICATE_ARN") or params.get("CustomerCognitoCertificateArn") or params["CloudFrontCertificateArn"]
    cert = aws("acm", "describe-certificate", "--certificate-arn", cert_arn)["Certificate"]
    auth = domain_info(AUTH)
    print("Hosted zone:", hosted["Name"], zone, "| private:", hosted.get("Config", {}).get("PrivateZone"))
    print("Delegation:", ", ".join(zone_info.get("DelegationSet", {}).get("NameServers", [])))
    for r in dns:
        print("DNS:", r["Name"], r["Type"], r.get("AliasTarget", {}).get("DNSName") or [v["Value"] for v in r.get("ResourceRecords", [])])
    print("Custom domain:", auth.get("Status", "absent"), "| target:", auth.get("CloudFrontDistribution"))
    print("ACM:", cert["Status"], cert.get("SubjectAlternativeNames", []))
    if not validate:
        return cert_arn
    if cert["Status"] != "ISSUED" or not any(covers(n.lower(), AUTH) for n in cert["SubjectAlternativeNames"]):
        raise ValueError(f"Select an issued us-east-1 ACM certificate covering {AUTH}.")
    if hosted.get("Config", {}).get("PrivateZone") or not any(r["Name"].rstrip(".").lower() == DOMAIN and r["Type"] == "A" for r in dns):
        raise ValueError("The installed public Route 53 zone must contain the parent A record.")
    socket.getaddrinfo(DOMAIN, 443, family=socket.AF_INET)
    rows = aws("cloudformation", "list-stack-resources", "--stack-name", stack["StackId"])["StackResourceSummaries"]
    owned = {r["LogicalResourceId"] for r in rows if r.get("PhysicalResourceId") and r["ResourceStatus"] not in {"DELETE_COMPLETE", "DELETE_SKIPPED"}}
    if params["CustomerCognitoDomainMode"] in {"prefix", "custom-with-prefix"}:
        prefix = domain_info(params["CustomerCognitoDomainPrefix"])
        if prefix.get("UserPoolId") != out["CustomerUserPoolId"] or "CustomerUserPoolDomain" not in owned:
            raise ValueError("The installed prefix is not managed by the expected customer pool and stack.")
    if auth.get("UserPoolId") and (auth["UserPoolId"] != out["CustomerUserPoolId"] or "CustomerUserPoolCustomDomain" not in owned):
        raise ValueError("The auth hostname already has a domain outside this stack's managed custom-domain resource.")
    dns_owners = {"A": "CustomerCognitoDnsA", "AAAA": "CustomerCognitoDnsAaaa"}
    for r in dns:
        if r["Name"].rstrip(".").lower() == AUTH and dns_owners.get(r["Type"]) not in owned:
            raise ValueError("An unmanaged auth DNS record already exists. Reconcile ownership before proceeding.")
    return cert_arn


def inspect_email(validate):
    sender = aws("sesv2", "get-email-identity", "--email-identity", DOMAIN)
    ses = aws("sesv2", "get-account")
    verified = sender.get("VerifiedForSendingStatus")
    dkim = sender.get("DkimAttributes", {}).get("Status")
    print("SES verified:", verified, "| DKIM:", dkim, "| production:", ses.get("ProductionAccessEnabled"), "| sending:", ses.get("SendingEnabled"))
    if validate and not (verified and dkim == "SUCCESS" and ses.get("ProductionAccessEnabled") and ses.get("SendingEnabled")):
        raise ValueError("Verify the identity and DKIM, and enable SES production sending in us-east-1.")


def main(action, scope):
    stack = aws("cloudformation", "describe-stacks", "--stack-name", "webwatch-prod")["Stacks"][0]
    p = {v["ParameterKey"]: v["ParameterValue"] for v in stack["Parameters"]}
    out = {v["OutputKey"]: v["OutputValue"] for v in stack["Outputs"]}
    if p.get("Stage") != "prod" or out.get("PublicUrl", "").rstrip("/") != f"https://{DOMAIN}" or p.get("CustomerCognitoCustomDomain") != AUTH:
        raise ValueError("The selected stack does not match production cloversight.app.")
    print("Stack:", stack["StackId"], stack["StackStatus"])
    print("Customer sign-in output:", out.get("CustomerCognitoDomain"), "| installed mode:", p["CustomerCognitoDomainMode"])
    for kind in ("Customer", "Steward"):
        pool = aws("cognito-idp", "describe-user-pool", "--user-pool-id", out[kind + "UserPoolId"])["UserPool"]
        email = pool.get("EmailConfiguration", {})
        print(kind, pool["Id"], "| prefix:", pool.get("Domain"), "| custom:", pool.get("CustomDomain"),
              "| mail:", email.get("EmailSendingAccount", "COGNITO_DEFAULT"), email.get("From", "AWS default"))
    validate = action == "plan"
    if validate and stack["StackStatus"] not in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}:
        raise ValueError("Wait for the installed production stack to settle.")
    cert = inspect_domain(stack, p, out, validate) if scope in {"both", "domain"} else None
    if scope in {"both", "email"}:
        inspect_email(validate)
    if not validate:
        return
    param_list = plan_parameters(p, cert, scope)
    if all(v.get("UsePreviousValue") for v in param_list):
        print("Requested settings are already installed. Check the published config and exercise sign-in and mail.")
        return
    result = aws("cloudformation", "create-change-set", "--stack-name", stack["StackId"],
                 "--change-set-name", f"branded-login-{time.time_ns()}", "--change-set-type", "UPDATE",
                 "--use-previous-template", "--role-arn", stack["RoleARN"], "--capabilities", "CAPABILITY_NAMED_IAM",
                 "--parameters", json.dumps(param_list))
    print("Change set prepared. Review it before execution.\n" + result["Id"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inspect", "plan"])
    parser.add_argument("--only", choices=["domain", "email"], help="Work on one feature independently")
    args = parser.parse_args()
    try:
        main(args.action, args.only or "both")
    except (RuntimeError, ValueError, OSError, KeyError) as exc:
        sys.exit(str(exc))
