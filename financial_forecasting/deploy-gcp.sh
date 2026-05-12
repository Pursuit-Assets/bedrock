#!/bin/bash

# GCP Deployment Script for Financial Forecasting App
# This script deploys both frontend and backend to Google Cloud Run

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting GCP Deployment...${NC}"

# Check if required variables are set
if [ -z "$GCP_PROJECT_ID" ]; then
    echo -e "${RED}❌ Error: GCP_PROJECT_ID environment variable is not set${NC}"
    echo "Please set it with: export GCP_PROJECT_ID=your-project-id"
    exit 1
fi

if [ -z "$GCP_REGION" ]; then
    echo -e "${YELLOW}⚠️  GCP_REGION not set, using default: us-central1${NC}"
    GCP_REGION="us-central1"
fi

# Service names
BACKEND_SERVICE="financial-forecasting-api"
FRONTEND_SERVICE="financial-forecasting-web"

echo -e "${GREEN}📋 Configuration:${NC}"
echo "  Project ID: $GCP_PROJECT_ID"
echo "  Region: $GCP_REGION"
echo "  Backend Service: $BACKEND_SERVICE"
echo "  Frontend Service: $FRONTEND_SERVICE"
echo ""

# Set GCP project
echo -e "${GREEN}🔧 Setting GCP project...${NC}"
gcloud config set project $GCP_PROJECT_ID

# Enable required APIs
echo -e "${GREEN}🔌 Enabling required GCP APIs...${NC}"
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
gcloud services enable artifactregistry.googleapis.com

# Deploy Backend
echo -e "${GREEN}🐍 Deploying Backend (FastAPI)...${NC}"
gcloud run deploy $BACKEND_SERVICE \
    --source . \
    --region $GCP_REGION \
    --platform managed \
    --allow-unauthenticated \
    --memory 1Gi \
    --cpu 1 \
    --timeout 300 \
    --max-instances 10 \
    --min-instances 1

# Get backend URL
BACKEND_URL=$(gcloud run services describe $BACKEND_SERVICE --region $GCP_REGION --format 'value(status.url)')
echo -e "${GREEN}✅ Backend deployed at: ${BACKEND_URL}${NC}"

# Deploy Frontend.
#
# The shipped frontend is `frontend-v2/` (Vite + React 19 — Bedrock
# Redesign). The legacy `frontend/` CRA build is kept on disk for
# historical reasons but is NOT what production serves; deploying from
# it ships an old UI and silently rolls back days/weeks of work
# (incident: 2026-05-11). nginx inside the v2 image proxies /api and
# /auth to the backend Cloud Run URL, so no env vars are needed.
echo -e "${GREEN}⚛️  Deploying Frontend (frontend-v2 · Vite + React 19)...${NC}"
cd frontend-v2

gcloud run deploy $FRONTEND_SERVICE \
    --source . \
    --region $GCP_REGION \
    --platform managed \
    --allow-unauthenticated \
    --memory 512Mi \
    --cpu 1 \
    --timeout 60 \
    --max-instances 10 \
    --min-instances 0

# Get frontend URL
FRONTEND_URL=$(gcloud run services describe $FRONTEND_SERVICE --region $GCP_REGION --format 'value(status.url)')
echo -e "${GREEN}✅ Frontend deployed at: ${FRONTEND_URL}${NC}"

cd ..

# Summary
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Frontend URL: ${GREEN}${FRONTEND_URL}${NC}"
echo -e "Backend URL:  ${GREEN}${BACKEND_URL}${NC}"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: Update your Google OAuth settings:${NC}"
echo ""
echo "1. Go to: https://console.cloud.google.com/apis/credentials"
echo "2. Update your OAuth Client:"
echo ""
echo -e "   ${YELLOW}Authorized JavaScript origins:${NC}"
echo "   - $FRONTEND_URL"
echo ""
echo -e "   ${YELLOW}Authorized redirect URIs:${NC}"
echo "   - $BACKEND_URL/auth/google/callback"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: Update Cloud Run environment variables:${NC}"
echo ""
echo "Run these commands to set your secrets:"
echo ""
echo "  gcloud run services update $BACKEND_SERVICE --region $GCP_REGION \\"
echo "    --update-env-vars GOOGLE_CLIENT_ID=your-client-id,\\"
echo "    --update-env-vars GOOGLE_CLIENT_SECRET=your-client-secret,\\"
echo "    --update-env-vars JWT_SECRET_KEY=your-jwt-secret,\\"
echo "    --update-env-vars FIREFLIES_API_KEY=your-fireflies-key,\\"
echo "    --update-env-vars SLACK_BOT_TOKEN=your-slack-token,\\"
echo "    --update-env-vars GOOGLE_REDIRECT_URI=$BACKEND_URL/auth/google/callback"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"

