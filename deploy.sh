#!/bin/bash

# AWS Deployment Script for Social Media Backend
# Usage: ./deploy.sh

set -e  # Exit on error

# Configuration - UPDATE THESE VALUES
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "YOUR_ACCOUNT_ID")
ECR_REPO="social-media-backend"
ECS_CLUSTER="social-media-cluster"
ECS_SERVICE="social-media-backend-service"
IMAGE_TAG="latest"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting AWS Deployment...${NC}"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed. Please install it first.${NC}"
    exit 1
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install it first.${NC}"
    exit 1
fi

# Check AWS credentials
if [ "$AWS_ACCOUNT_ID" == "YOUR_ACCOUNT_ID" ]; then
    echo -e "${RED}❌ AWS credentials not configured. Run 'aws configure' first.${NC}"
    exit 1
fi

echo -e "${YELLOW}📦 Building Docker image...${NC}"
docker build -t $ECR_REPO:$IMAGE_TAG .

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Docker build failed!${NC}"
    exit 1
fi

echo -e "${YELLOW}🔐 Logging into ECR...${NC}"
aws ecr get-login-password --region $AWS_REGION | \
    docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ ECR login failed!${NC}"
    exit 1
fi

echo -e "${YELLOW}🏷️  Tagging image...${NC}"
docker tag $ECR_REPO:$IMAGE_TAG \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG

echo -e "${YELLOW}📤 Pushing to ECR...${NC}"
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Docker push failed!${NC}"
    exit 1
fi

echo -e "${YELLOW}🔄 Updating ECS service...${NC}"
aws ecs update-service \
    --cluster $ECS_CLUSTER \
    --service $ECS_SERVICE \
    --force-new-deployment \
    --region $AWS_REGION \
    --query 'service.serviceName' \
    --output text > /dev/null

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ ECS service update failed!${NC}"
    echo -e "${YELLOW}💡 Make sure the ECS cluster and service exist.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Deployment initiated successfully!${NC}"
echo -e "${YELLOW}📊 Check deployment status in AWS Console:${NC}"
echo -e "   https://console.aws.amazon.com/ecs/v2/clusters/$ECS_CLUSTER/services/$ECS_SERVICE"
echo ""
echo -e "${YELLOW}📝 View logs:${NC}"
echo -e "   aws logs tail /ecs/$ECR_REPO --follow --region $AWS_REGION"






