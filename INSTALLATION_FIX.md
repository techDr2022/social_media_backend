# 🔧 Installation Fix Guide

## Issue: npm Cache Mode Error

You're encountering an npm cache configuration issue: `cache mode is 'only-if-cached' but no cached response is available`

## ✅ Solutions

### Option 1: Clear npm Cache (Recommended)

```powershell
cd c:\Users\shiva\job\new\backend\api-service
npm cache clean --force
npm install --legacy-peer-deps
```

### Option 2: Check npm Configuration

```powershell
# Check if offline mode is enabled
npm config get cache
npm config get offline

# If offline is true, disable it
npm config set offline false

# Then install
npm install --legacy-peer-deps
```

### Option 3: Manual Installation

If the above doesn't work, install packages individually:

```powershell
cd c:\Users\shiva\job\new\backend\api-service

# Install with legacy peer deps to handle NestJS 11 compatibility
npm install @nestjs/schedule@^6.1.0 --legacy-peer-deps
npm install @nestjs/swagger@^8.0.5 --legacy-peer-deps
npm install helmet@^8.0.0 --legacy-peer-deps
npm install swagger-ui-express@^5.0.1 --legacy-peer-deps
```

### Option 4: Update package.json and Use Yarn (Alternative)

If npm continues to have issues, you can use yarn:

```powershell
# Install yarn if not already installed
npm install -g yarn

# Install dependencies
cd c:\Users\shiva\job\new\backend\api-service
yarn install
```

---

## 📝 Updated package.json

The `package.json` has been updated with:
- `@nestjs/schedule@^6.1.0` (compatible with NestJS 11)
- `@nestjs/swagger@^8.0.5`
- `helmet@^8.0.0`
- `swagger-ui-express@^5.0.1`

---

## ✅ After Installation

Once packages are installed, verify:

```powershell
# Check if packages are installed
npm list @nestjs/schedule @nestjs/swagger helmet swagger-ui-express

# Or check package.json
cat package.json | Select-String -Pattern "@nestjs/schedule|helmet|swagger"
```

---

## 🚀 Next Steps

After successful installation:

1. **Run database migration:**
   ```powershell
   npx prisma migrate dev --name add_optimized_indexes
   ```

2. **Verify the app starts:**
   ```powershell
   npm run start:dev
   ```

3. **Check health endpoint:**
   ```powershell
   curl http://localhost:3000/api/v1/health
   ```

---

## 💡 Why `--legacy-peer-deps`?

NestJS 11 is newer than some packages' peer dependency declarations. Using `--legacy-peer-deps` tells npm to ignore peer dependency conflicts, which is safe in this case since:
- NestJS maintains backward compatibility
- The packages work fine with NestJS 11
- It's a common practice for newer NestJS versions

---

## 🆘 Still Having Issues?

If you continue to have problems:

1. **Check npm version:**
   ```powershell
   npm --version
   ```

2. **Update npm:**
   ```powershell
   npm install -g npm@latest
   ```

3. **Reset npm config:**
   ```powershell
   npm config delete offline
   npm config delete cache
   ```

4. **Try with different registry:**
   ```powershell
   npm install --legacy-peer-deps --registry https://registry.npmjs.org/
   ```
