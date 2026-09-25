{{/*
Expand the name of the chart.
*/}}
{{- define "ai-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ai-platform.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Selector labels (used by deployments/services/hpa).
*/}}
{{- define "ai-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "ai-platform.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{ include "ai-platform.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
ServiceAccount name: explicit value wins, otherwise derived from the full
name. Used by every workload that needs migrate-waiting permissions.
*/}}
{{- define "ai-platform.serviceAccountName" -}}
{{- default (include "ai-platform.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{/*
Resolve the PostgreSQL host: auto-derived from the release name when the
in-cluster postgres is enabled, otherwise the explicitly configured host
(required when postgres.enabled=false, i.e. an external database).
*/}}
{{- define "ai-platform.postgresHost" -}}
{{- if .Values.postgres.enabled -}}
{{- default (printf "%s-postgres" (include "ai-platform.fullname" .)) .Values.config.postgres.host -}}
{{- else -}}
{{- required "config.postgres.host must be set when postgres.enabled=false (external database)" .Values.config.postgres.host -}}
{{- end -}}
{{- end }}

{{/*
Resolve the Redis host: auto-derived unless redis.enabled=false.
*/}}
{{- define "ai-platform.redisHost" -}}
{{- if .Values.redis.enabled -}}
{{- default (printf "%s-redis" (include "ai-platform.fullname" .)) .Values.config.redis.host -}}
{{- else -}}
{{- required "config.redis.host must be set when redis.enabled=false (external Redis)" .Values.config.redis.host -}}
{{- end -}}
{{- end }}

{{/*
Resolve the MinIO endpoint: auto-derived unless minio.enabled=false.
*/}}
{{- define "ai-platform.minioEndpoint" -}}
{{- if .Values.minio.enabled -}}
{{- default (printf "%s-minio:9000" (include "ai-platform.fullname" .)) .Values.config.minio.endpoint -}}
{{- else -}}
{{- required "config.minio.endpoint must be set when minio.enabled=false (external object storage)" .Values.config.minio.endpoint -}}
{{- end -}}
{{- end }}