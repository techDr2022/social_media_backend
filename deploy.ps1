# AWS Deployment Script for Social Media Backend (PowerShell)
# Usage: .\deploy.ps1

$ErrorActionPreference = "Stop"

# Configuration - UPDATE THESE VALUES
$AWS_REGION = "us-east-1"
$ECR_REPO = "social-media-backend"
$ECS_CLUSTER = "social-media-cluster"
$ECS_SERVICE = "social-media-backend-service"
$IMAGE_TAG = "latest"

Write-Host "🚀 Starting AWS Deployment..." -ForegroundColor Green

# Check if AWS CLI is installed
try {
    $null = aws --version 2>&1
} catch {
    Write-Host "❌ AWS CLI is not installed. Please install it first." -ForegroundColor Red
    exit 1
}

# Check if Docker is installed
try {
    $null = docker --version 2>&1
} catch {
    Write-Host "❌ Docker is not installed. Please install it first." -ForegroundColor Red
    exit 1
}

# Get AWS Account ID
try {
    $AWS_ACCOUNT_ID = aws sts get-caller-identity --query Account --output text 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "AWS credentials not configured"
    }
} catch {
    Write-Host "❌ AWS credentials not configured. Run 'aws configure' first." -ForegroundColor Red
    exit 1
}

Write-Host "📦 Building Docker image..." -ForegroundColor Yellow
docker build -t "${ECR_REPO}:${IMAGE_TAG}" .

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Docker build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "🔐 Logging into ECR..." -ForegroundColor Yellow
$loginCommand = aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ ECR login failed!" -ForegroundColor Red
    exit 1
}

Write-Host "🏷️  Tagging image..." -ForegroundColor Yellow
docker tag "${ECR_REPO}:${IMAGE_TAG}" "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

Write-Host "📤 Pushing to ECR..." -ForegroundColor Yellow
docker push "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Docker push failed!" -ForegroundColor Red
    exit 1
}

Write-Host "🔄 Updating ECS service..." -ForegroundColor Yellow
aws ecs update-service `
    --cluster $ECS_CLUSTER `
    --service $ECS_SERVICE `
    --force-new-deployment `
    --region $AWS_REGION `
    --query 'service.serviceName' `
    --output text | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ ECS service update failed!" -ForegroundColor Red
    Write-Host "💡 Make sure the ECS cluster and service exist." -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Deployment initiated successfully!" -ForegroundColor Green
Write-Host "📊 Check deployment status in AWS Console:" -ForegroundColor Yellow
Write-Host "   https://console.aws.amazon.com/ecs/v2/clusters/$ECS_CLUSTER/services/$ECS_SERVICE"
Write-Host ""
Write-Host "📝 View logs:" -ForegroundColor Yellow
Write-Host "   aws logs tail /ecs/$ECR_REPO --follow --region $AWS_REGION"






