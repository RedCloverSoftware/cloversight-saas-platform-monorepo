# CloudFormation resource inventory

Generated from `infra/cloudformation/*.yaml` by `scripts/generate-doc-reference.py`.
Logical resources are conditional where noted; this is source inventory, not proof of a deployed stack.

## Primary control plane

Source: `infra/cloudformation/webwatch.yaml`. 178 logical resources; 54 parameters; 58 outputs.

Services: ApiGatewayV2 (31), Budgets (3), CloudFront (13), CloudWatch (18), Cognito (10), DynamoDB (4), Events (1), IAM (7), KMS (2), Lambda (19), Logs (15), Route53 (15), S3 (10), SES (4), SNS (3), SQS (11), SecretsManager (4), WAFv2 (8).

| Logical ID | AWS resource type | Condition |
| --- | --- | --- |
| `DataKey` | `AWS::KMS::Key` | `always` |
| `DataKeyAlias` | `AWS::KMS::Alias` | `always` |
| `StewardAuditTable` | `AWS::DynamoDB::Table` | `always` |
| `CoreTable` | `AWS::DynamoDB::Table` | `always` |
| `IdempotencyTable` | `AWS::DynamoDB::Table` | `always` |
| `ClosedAccountsTable` | `AWS::DynamoDB::Table` | `always` |
| `SnapshotBucket` | `AWS::S3::Bucket` | `always` |
| `InboundMailBucket` | `AWS::S3::Bucket` | `always` |
| `InboundMailBucketPolicy` | `AWS::S3::BucketPolicy` | `always` |
| `PublicWebBucket` | `AWS::S3::Bucket` | `always` |
| `CustomerWebBucket` | `AWS::S3::Bucket` | `always` |
| `StewardWebBucket` | `AWS::S3::Bucket` | `always` |
| `StripeSecret` | `AWS::SecretsManager::Secret` | `always` |
| `TwilioSecret` | `AWS::SecretsManager::Secret` | `always` |
| `ResponseSecret` | `AWS::SecretsManager::Secret` | `always` |
| `OriginVerifySecret` | `AWS::SecretsManager::Secret` | `always` |
| `CheckDeadLetterQueue` | `AWS::SQS::Queue` | `always` |
| `CheckQueue` | `AWS::SQS::Queue` | `always` |
| `CaptureDeadLetterQueue` | `AWS::SQS::Queue` | `always` |
| `CaptureQueue` | `AWS::SQS::Queue` | `always` |
| `CaptureResultDeadLetterQueue` | `AWS::SQS::Queue` | `always` |
| `CaptureResultQueue` | `AWS::SQS::Queue` | `always` |
| `BillingDeadLetterQueue` | `AWS::SQS::Queue` | `always` |
| `BillingQueue` | `AWS::SQS::Queue` | `always` |
| `ReportDeadLetterQueue` | `AWS::SQS::Queue` | `always` |
| `ReportQueue` | `AWS::SQS::Queue` | `always` |
| `PreTokenRole` | `AWS::IAM::Role` | `always` |
| `CustomerPreTokenFunction` | `AWS::Lambda::Function` | `always` |
| `StewardPreTokenFunction` | `AWS::Lambda::Function` | `always` |
| `CustomerPreTokenLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `StewardPreTokenLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `CustomerUserPool` | `AWS::Cognito::UserPool` | `always` |
| `StewardUserPool` | `AWS::Cognito::UserPool` | `always` |
| `CustomerPreTokenPermission` | `AWS::Lambda::Permission` | `always` |
| `StewardPreTokenPermission` | `AWS::Lambda::Permission` | `always` |
| `CustomerUserPoolClient` | `AWS::Cognito::UserPoolClient` | `always` |
| `StewardUserPoolClient` | `AWS::Cognito::UserPoolClient` | `always` |
| `CustomerUserPoolDomain` | `AWS::Cognito::UserPoolDomain` | `UseCustomerPrefixDomain` |
| `CustomerUserPoolCustomDomain` | `AWS::Cognito::UserPoolDomain` | `UseCustomerCustomDomain` |
| `StewardUserPoolDomain` | `AWS::Cognito::UserPoolDomain` | `always` |
| `CustomerManagedLoginBranding` | `AWS::Cognito::ManagedLoginBranding` | `UseCustomerPrefixDomain` |
| `CustomerCustomManagedLoginBranding` | `AWS::Cognito::ManagedLoginBranding` | `UseCustomOnlyBranding` |
| `StewardManagedLoginBranding` | `AWS::Cognito::ManagedLoginBranding` | `always` |
| `EdgeIpv4Set` | `AWS::WAFv2::IPSet` | `IsStaging` |
| `EdgeIpv6Set` | `AWS::WAFv2::IPSet` | `IsStaging` |
| `RegionalIpv4Set` | `AWS::WAFv2::IPSet` | `IsStaging` |
| `RegionalIpv6Set` | `AWS::WAFv2::IPSet` | `IsStaging` |
| `EdgeWebAcl` | `AWS::WAFv2::WebACL` | `IsStaging` |
| `RegionalWebAcl` | `AWS::WAFv2::WebACL` | `IsStaging` |
| `CustomerCognitoWafAssociation` | `AWS::WAFv2::WebACLAssociation` | `IsStaging` |
| `StewardCognitoWafAssociation` | `AWS::WAFv2::WebACLAssociation` | `IsStaging` |
| `ApiRole` | `AWS::IAM::Role` | `always` |
| `WorkerRole` | `AWS::IAM::Role` | `always` |
| `ReportRole` | `AWS::IAM::Role` | `always` |
| `DispatcherRole` | `AWS::IAM::Role` | `always` |
| `CaptureRole` | `AWS::IAM::Role` | `always` |
| `InboundEmailRole` | `AWS::IAM::Role` | `always` |
| `CaptureFunction` | `AWS::Lambda::Function` | `always` |
| `CaptureLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `ApiFunction` | `AWS::Lambda::Function` | `always` |
| `ApiLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `WorkerFunction` | `AWS::Lambda::Function` | `always` |
| `WorkerLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `BillingFunction` | `AWS::Lambda::Function` | `always` |
| `BillingLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `ReportFunction` | `AWS::Lambda::Function` | `always` |
| `ReportLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `CheckEventSource` | `AWS::Lambda::EventSourceMapping` | `always` |
| `CaptureEventSource` | `AWS::Lambda::EventSourceMapping` | `always` |
| `CaptureResultEventSource` | `AWS::Lambda::EventSourceMapping` | `always` |
| `BillingEventSource` | `AWS::Lambda::EventSourceMapping` | `always` |
| `ReportEventSource` | `AWS::Lambda::EventSourceMapping` | `always` |
| `DispatcherFunction` | `AWS::Lambda::Function` | `always` |
| `DispatcherLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `DispatchRule` | `AWS::Events::Rule` | `always` |
| `DispatchPermission` | `AWS::Lambda::Permission` | `always` |
| `InboundEmailFunction` | `AWS::Lambda::Function` | `always` |
| `InboundEmailLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `HttpApi` | `AWS::ApiGatewayV2::Api` | `always` |
| `ApiIntegration` | `AWS::ApiGatewayV2::Integration` | `always` |
| `CustomerAuthorizer` | `AWS::ApiGatewayV2::Authorizer` | `always` |
| `StewardAuthorizer` | `AWS::ApiGatewayV2::Authorizer` | `always` |
| `HealthRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `AssetRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `StripeWebhookRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `TwilioInboundRoute` | `AWS::ApiGatewayV2::Route` | `EnableTwilio` |
| `TwilioStatusRoute` | `AWS::ApiGatewayV2::Route` | `EnableTwilio` |
| `ResponsePageRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `UnsubscribePageRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `AlertResponseRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `AlertCodeResponseRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `CustomerBootstrapRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `CustomerSnapshotAssetsRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `WatcherCreateRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `WatcherProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `CheckStatusRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `BannedPhraseRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `BillingProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `TransactionProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `AccountProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `UserProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `TeamRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `TeamProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `ActionLogRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `ActionLogProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `ReportsRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `ReportsProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `StewardProxyRoute` | `AWS::ApiGatewayV2::Route` | `always` |
| `ApiAccessLog` | `AWS::Logs::LogGroup` | `always` |
| `ApiStage` | `AWS::ApiGatewayV2::Stage` | `always` |
| `ApiInvokePermission` | `AWS::Lambda::Permission` | `always` |
| `SesDomainIdentity` | `AWS::SES::EmailIdentity` | `always` |
| `SesDkimRecord1` | `AWS::Route53::RecordSet` | `always` |
| `SesDkimRecord2` | `AWS::Route53::RecordSet` | `always` |
| `SesDkimRecord3` | `AWS::Route53::RecordSet` | `always` |
| `SesMailFromMx` | `AWS::Route53::RecordSet` | `always` |
| `SesMailFromSpf` | `AWS::Route53::RecordSet` | `always` |
| `SesDmarcRecord` | `AWS::Route53::RecordSet` | `always` |
| `ReplyMxRecord` | `AWS::Route53::RecordSet` | `always` |
| `SesConfigurationSet` | `AWS::SES::ConfigurationSet` | `always` |
| `InboundEmailInvokePermission` | `AWS::Lambda::Permission` | `always` |
| `SesReceiptRule` | `AWS::SES::ReceiptRule` | `always` |
| `WebOriginAccessControl` | `AWS::CloudFront::OriginAccessControl` | `always` |
| `PublicUrlRewriteFunction` | `AWS::CloudFront::Function` | `always` |
| `CustomerSpaRewriteFunction` | `AWS::CloudFront::Function` | `always` |
| `CustomerLegacyRedirectFunction` | `AWS::CloudFront::Function` | `always` |
| `StewardSpaRewriteFunction` | `AWS::CloudFront::Function` | `always` |
| `PortalResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | `always` |
| `PublicResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | `always` |
| `StaticCachePolicy` | `AWS::CloudFront::CachePolicy` | `always` |
| `ApiNoCachePolicy` | `AWS::CloudFront::CachePolicy` | `always` |
| `ApiOriginRequestPolicy` | `AWS::CloudFront::OriginRequestPolicy` | `always` |
| `PublicDistribution` | `AWS::CloudFront::Distribution` | `always` |
| `CustomerDistribution` | `AWS::CloudFront::Distribution` | `always` |
| `StewardDistribution` | `AWS::CloudFront::Distribution` | `always` |
| `PublicWebBucketPolicy` | `AWS::S3::BucketPolicy` | `always` |
| `CustomerWebBucketPolicy` | `AWS::S3::BucketPolicy` | `always` |
| `StewardWebBucketPolicy` | `AWS::S3::BucketPolicy` | `always` |
| `PublicDnsA` | `AWS::Route53::RecordSet` | `always` |
| `PublicDnsAaaa` | `AWS::Route53::RecordSet` | `EnableViewerIpv6` |
| `CustomerDnsA` | `AWS::Route53::RecordSet` | `always` |
| `CustomerDnsAaaa` | `AWS::Route53::RecordSet` | `EnableViewerIpv6` |
| `CustomerCognitoDnsA` | `AWS::Route53::RecordSet` | `UseCustomerCustomDomain` |
| `CustomerCognitoDnsAaaa` | `AWS::Route53::RecordSet` | `UseCustomerCustomDomainWithIpv6` |
| `StewardDnsA` | `AWS::Route53::RecordSet` | `always` |
| `StewardDnsAaaa` | `AWS::Route53::RecordSet` | `EnableViewerIpv6` |
| `OpsTopic` | `AWS::SNS::Topic` | `always` |
| `OpsTopicPolicy` | `AWS::SNS::TopicPolicy` | `always` |
| `SesFeedbackEventDestination` | `AWS::SES::ConfigurationSetEventDestination` | `always` |
| `OpsEmailSubscription` | `AWS::SNS::Subscription` | `EnableOpsSubscription` |
| `ApiErrorAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `DispatcherHeartbeatMetric` | `AWS::Logs::MetricFilter` | `always` |
| `DispatcherHeartbeatAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `MaintenanceHeartbeatMetric` | `AWS::Logs::MetricFilter` | `always` |
| `MaintenanceHeartbeatAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `MaintenanceTaskFailureMetric` | `AWS::Logs::MetricFilter` | `always` |
| `MaintenanceTaskFailureAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `PrimaryCaptureErrorAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `PrimaryCaptureThrottleAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `PrimaryCaptureQueueAgeAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `WorkerErrorAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `CaptureIncompleteRunMetric` | `AWS::Logs::MetricFilter` | `always` |
| `CaptureIncompleteMaintenanceMetric` | `AWS::Logs::MetricFilter` | `always` |
| `CaptureIncompleteRunAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `BillingErrorAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `ReportErrorAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `CheckDlqAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `CaptureDlqAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `CaptureResultDlqAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `BillingDlqAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `ReportDlqAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `MonthlyBudgetWithAlerts` | `AWS::Budgets::Budget` | `EnableTechnicalAlerts` |
| `MonthlyBudgetWithoutAlerts` | `AWS::Budgets::Budget` | `DisableTechnicalAlerts` |
| `ScopedMonthlyBudget` | `AWS::Budgets::Budget` | `CreateScopedBudget` |
| `SnapshotBucketPolicy` | `AWS::S3::BucketPolicy` | `always` |
| `QueueTransportPolicy` | `AWS::SQS::QueuePolicy` | `always` |
| `CheckQueueAgeAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `CaptureResultQueueAgeAlarm` | `AWS::CloudWatch::Alarm` | `always` |

### Outputs

| Name |
| --- |
| `ApiUrl` |
| `StripeWebhookUrl` |
| `TwilioInboundWebhookUrl` |
| `TwilioStatusWebhookUrl` |
| `PublicUrl` |
| `CustomerUrl` |
| `LegacyCustomerUrl` |
| `StewardUrl` |
| `PublicDistributionId` |
| `CustomerDistributionId` |
| `StewardDistributionId` |
| `PublicBucket` |
| `CustomerBucket` |
| `StewardBucket` |
| `SnapshotBucket` |
| `SnapshotBucketRegion` |
| `DataKeyArn` |
| `CaptureFunctionName` |
| `CaptureQueueName` |
| `CaptureQueueUrl` |
| `CaptureResultQueueUrl` |
| `CaptureResultQueueArn` |
| `ReportQueueUrl` |
| `InboundMailBucket` |
| `CoreTable` |
| `CustomerUserPoolId` |
| `CustomerClientId` |
| `CustomerCognitoDomain` |
| `StewardAuditTableName` |
| `StewardUserPoolId` |
| `StewardClientId` |
| `StewardCognitoDomain` |
| `StripeSecretArn` |
| `TwilioSecretArn` |
| `ResponseSecretArn` |
| `OriginVerifySecretArn` |
| `SesReceiptRuleSetOutput` |
| `SesReceiptRuleNameOutput` |
| `EdgeWebAclArn` |
| `RegionalWebAclArn` |
| `EdgeIpv4SetId` |
| `EdgeIpv6SetId` |
| `RegionalIpv4SetId` |
| `RegionalIpv6SetId` |
| `EdgeIpv4SetName` |
| `EdgeIpv6SetName` |
| `RegionalIpv4SetName` |
| `RegionalIpv6SetName` |
| `CheckQueueUrl` |
| `BillingQueueUrl` |
| `OpsTopicArn` |
| `AccountBudgetName` |
| `AccountBudgetScope` |
| `ScopedBudgetName` |
| `ScopedBudgetScope` |
| `SesIdentity` |
| `SesConfigurationSetName` |
| `SesFromAddressOutput` |

## Regional capture

Source: `infra/cloudformation/regional-capture.yaml`. 17 logical resources; 12 parameters; 9 outputs.

Services: CloudWatch (4), IAM (1), KMS (1), Lambda (2), Logs (1), S3 (2), SNS (3), SQS (3).

| Logical ID | AWS resource type | Condition |
| --- | --- | --- |
| `CaptureBucket` | `AWS::S3::Bucket` | `always` |
| `CaptureDeadLetterQueue` | `AWS::SQS::Queue` | `always` |
| `CaptureQueue` | `AWS::SQS::Queue` | `always` |
| `RegionalCaptureRole` | `AWS::IAM::Role` | `always` |
| `RegionalCaptureFunction` | `AWS::Lambda::Function` | `always` |
| `RegionalCaptureEventSource` | `AWS::Lambda::EventSourceMapping` | `always` |
| `RegionalCaptureLogGroup` | `AWS::Logs::LogGroup` | `always` |
| `RegionalOpsKey` | `AWS::KMS::Key` | `always` |
| `RegionalOpsTopic` | `AWS::SNS::Topic` | `always` |
| `RegionalOpsTopicPolicy` | `AWS::SNS::TopicPolicy` | `always` |
| `RegionalOpsEmailSubscription` | `AWS::SNS::Subscription` | `HasOpsAlertEmail` |
| `RegionalCaptureErrorAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `RegionalCaptureThrottleAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `RegionalCaptureQueueAgeAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `RegionalCaptureDlqAlarm` | `AWS::CloudWatch::Alarm` | `always` |
| `CaptureBucketPolicy` | `AWS::S3::BucketPolicy` | `always` |
| `QueueTransportPolicy` | `AWS::SQS::QueuePolicy` | `always` |

### Outputs

| Name |
| --- |
| `FunctionName` |
| `FunctionArn` |
| `CaptureBucketName` |
| `CaptureBucketRegion` |
| `CaptureQueueName` |
| `CaptureQueueUrl` |
| `CaptureQueueArn` |
| `CaptureDeadLetterQueueUrl` |
| `OpsTopicArn` |

