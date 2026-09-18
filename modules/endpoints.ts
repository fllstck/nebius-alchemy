import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/**
 * Endpoint mappings for Nebius gRPC services.
 *
 * Each entry maps a fully-qualified protobuf service name to its gRPC
 * endpoint. Services that share an endpoint will reuse the same underlying
 * gRPC channel via NebiusGrpcTransport's channel cache.
 *
 * Endpoint data sourced from the Nebius API catalog (ENDPOINTS.md).
 */

const DEFAULT_ENDPOINTS: Record<string, string> = {
  // --- Billing ---
  'nebius.billing.v1alpha1.OneTimeExportService':
    'api.billing-report-exporter.billing-data-plane.api.nebius.cloud:443',
  'nebius.billing.v1.CalculatorService':
    'api.calculator.billing-data-plane.api.nebius.cloud:443',
  'nebius.billing.v1alpha1.CalculatorService':
    'api.calculator.billing-data-plane.api.nebius.cloud:443',

  // --- AI / MSP ---
  'nebius.ai.v1.EndpointService': 'apps.msp.api.nebius.cloud:443',
  'nebius.ai.v1.JobService': 'apps.msp.api.nebius.cloud:443',
  // Devlab runs on the MSP control plane alongside Endpoint/Job.
  'nebius.ai.v1.DevlabService': 'apps.msp.api.nebius.cloud:443',

  // --- Audit ---
  'nebius.audit.v2.AuditEventExportService': 'audit.api.nebius.cloud:443',
  'nebius.audit.v2.AuditEventService': 'audit.api.nebius.cloud:443',

  // --- Capacity ---
  'nebius.capacity.v1.ResourceAdviceService':
    'capacity-advisor.billing-cpl.api.nebius.cloud:443',
  'nebius.capacity.v1.CapacityAllowanceService':
    'capacity-blocks.billing-cpl.api.nebius.cloud:443',
  'nebius.capacity.v1.CapacityBlockGroupService':
    'capacity-blocks.billing-cpl.api.nebius.cloud:443',
  'nebius.capacity.v1.CapacityIntervalService':
    'capacity-blocks.billing-cpl.api.nebius.cloud:443',

  // --- Compute ---
  'nebius.compute.v1.DiskService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.DiskSnapshotService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.FilesystemService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.GpuClusterService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.ImageService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.InstanceService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.MaintenanceService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.NVLInstanceGroupService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.NodeService': 'compute.api.nebius.cloud:443',
  'nebius.compute.v1.PlatformService': 'compute.api.nebius.cloud:443',

  // --- IAM (Control Plane) ---
  'nebius.iam.v1.AccessKeyService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v2.AccessKeyService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.AccessPermitService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.AuthPublicKeyService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.FederatedCredentialsService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.FederationCertificateService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.FederationService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.GroupMembershipService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.GroupService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.InvitationService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.ProfileService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.ProjectService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v2.ProjectService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.ServiceAccountService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.SessionManagementService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.StaticKeyService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.TenantService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v2.TenantService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.TenantUserAccountService': 'cpl.iam.api.nebius.cloud:443',
  'nebius.iam.v1.TenantUserAccountWithAttributesService':
    'cpl.iam.api.nebius.cloud:443',

  // --- IAM (Token Exchange — separate endpoint) ---
  'nebius.iam.v1.TokenExchangeService': 'tokens.iam.api.nebius.cloud:443',

  // --- KMS (Control Plane) ---
  'nebius.kms.v1.AsymmetricKeyService': 'cpl.kms.api.nebius.cloud:443',
  'nebius.kms.v1.SymmetricKeyService': 'cpl.kms.api.nebius.cloud:443',

  // --- KMS (Data Plane) ---
  'nebius.kms.v1.AsymmetricCryptoService': 'dpl.kms.api.nebius.cloud:443',
  'nebius.kms.v1.SymmetricCryptoService': 'dpl.kms.api.nebius.cloud:443',

  // --- Mysterybox (Control Plane) ---
  'nebius.mysterybox.v1.SecretService': 'cpl.mysterybox.api.nebius.cloud:443',
  'nebius.mysterybox.v1.SecretVersionService':
    'cpl.mysterybox.api.nebius.cloud:443',

  // --- Mysterybox (Data Plane) ---
  'nebius.mysterybox.v1.PayloadService':
    'dpl.mysterybox.api.nebius.cloud:443',

  // --- Storage (Control Plane) ---
  'nebius.storage.v1.BucketService': 'cpl.storage.api.nebius.cloud:443',
  // S3 Inventory configuration lives on the same control-plane host.
  'nebius.storage.v1.InventoryService': 'cpl.storage.api.nebius.cloud:443',

  // --- Storage (Transfer — separate endpoint) ---
  'nebius.storage.v1.TransferService':
    'transfer.storage.api.nebius.cloud:443',
  'nebius.storage.v1alpha1.TransferService':
    'transfer.storage.api.nebius.cloud:443',

  // --- Logging ---
  'nebius.logging.v1.LogExportService': 'cpl.teplo.api.nebius.cloud:443',
  'nebius.logging.agentmanager.v1.VersionService':
    'observability-agent-manager.api.nebius.cloud:443',

  // --- Applications ---
  'nebius.applications.v1alpha1.K8sReleaseService':
    'deployment-manager.mkt.api.nebius.cloud:443',
  'nebius.applications.v1alpha1.VmAppTemplateService':
    'deployment-manager.mkt.api.nebius.cloud:443',

  // --- DNS ---
  'nebius.dns.v1.RecordService': 'dns.api.nebius.cloud:443',
  'nebius.dns.v1.ZoneService': 'dns.api.nebius.cloud:443',

  // --- Maintenance ---
  'nebius.maintenance.v1alpha1.MaintenanceService':
    'maintenance.msp.api.nebius.cloud:443',

  // --- Managed Kubernetes ---
  'nebius.mk8s.v1.ClusterService': 'mk8s.api.nebius.cloud:443',
  'nebius.mk8s.v1.NodeGroupService': 'mk8s.api.nebius.cloud:443',
  'nebius.mk8s.v1alpha1.ClusterService': 'mk8s.api.nebius.cloud:443',
  'nebius.mk8s.v1alpha1.NodeGroupService': 'mk8s.api.nebius.cloud:443',

  // --- MSP (MLflow) ---
  'nebius.msp.mlflow.v1alpha1.ClusterService':
    'mlflow.msp.api.nebius.cloud:443',

  // --- MSP (PostgreSQL) ---
  'nebius.msp.postgresql.v1alpha1.BackupService':
    'postgresql.msp.api.nebius.cloud:443',
  'nebius.msp.postgresql.v1alpha1.ClusterService':
    'postgresql.msp.api.nebius.cloud:443',

  // --- Tunnel (Application Tunnel) ---
  'nebius.tunnel.v1.TunnelService':
    'applicationtunnel.mkt.api.nebius.cloud:443',

  // --- Quotas ---
  'nebius.quotas.v1.QuotaAllowanceService':
    'quota-dispatcher.billing-cpl.api.nebius.cloud:443',

  // --- Registry ---
  'nebius.registry.v1.ArtifactService': 'registry.api.nebius.cloud:443',
  'nebius.registry.v1.RegistryService': 'registry.api.nebius.cloud:443',

  // --- VPC ---
  'nebius.vpc.v1.AllocationService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.NetworkService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.PoolService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.RouteService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.RouteTableService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.SecurityGroupService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.SecurityRuleService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.SubnetService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1.TargetGroupService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1alpha1.AllocationService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1alpha1.NetworkService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1alpha1.PoolService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1alpha1.ScopeService': 'vpc.api.nebius.cloud:443',
  'nebius.vpc.v1alpha1.SubnetService': 'vpc.api.nebius.cloud:443',

  // --- Monitoring ---
  'nebius.monitoring.v1.RecordingRuleService':
    'monitoring.api.nebius.cloud:443',

  // --- Common (OperationService — appears on many endpoints) ---
  //
  // OperationService is deployed per-endpoint. Operations must be polled
  // on the same endpoint that created them. For a generic fallback, we
  // point to cpl.storage (our primary service). Override for specific
  // domains as needed.
  'nebius.common.v1.OperationService':
    'cpl.storage.api.nebius.cloud:443',
  'nebius.common.v1alpha1.OperationService':
    'cpl.storage.api.nebius.cloud:443',
}

/**
 * Error raised when a protobuf service name is not found in the endpoint
 * catalog. Callers should handle this gracefully rather than crashing.
 */
export class UnknownServiceError extends Schema.TaggedError<UnknownServiceError>()(
  'UnknownServiceError',
  {
    service: Schema.String,
  },
) {}

/**
 * Resolve the gRPC endpoint for a named protobuf service.
 *
 * @param service - Fully-qualified protobuf service name
 *   (e.g. "nebius.storage.v1.BucketService").
 * @returns An Effect that succeeds with the endpoint string
 *   (e.g. "cpl.storage.api.nebius.cloud:443") or fails with
 *   {@link UnknownServiceError} if the service is not in the catalog.
 */
export const endpointFor = (service: string): Effect.Effect<string, UnknownServiceError> => {
  const endpoint = DEFAULT_ENDPOINTS[service]
  if (!endpoint) {
    return Effect.fail(
      new UnknownServiceError({ service }),
    )
  }
  return Effect.succeed(endpoint)
}
