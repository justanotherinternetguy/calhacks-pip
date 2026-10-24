#!/usr/bin/env bash
# Build the Rust core (safety-ffi) for Android + iOS and generate uniffi bindings.
#
#   core/build-mobile.sh                # android (+ ios on macOS)
#   core/build-mobile.sh --android-only
#   core/build-mobile.sh --ios-only     # macOS only
#
# Outputs (written to BOTH the Expo module dirs and core/target/mobile/):
#   apps/mobile/modules/safety-native/android/src/main/jniLibs/{arm64-v8a,x86_64}/libsafety_ffi.so
#   apps/mobile/modules/safety-native/android/src/main/java/uniffi/safety/safety.kt
#   apps/mobile/modules/safety-native/android/src/main/assets/model-v1.toml
#   apps/mobile/modules/safety-native/ios/Frameworks/safety.xcframework
#   apps/mobile/modules/safety-native/ios/Generated/{safety.swift,safetyFFI.h,module.modulemap}
#   apps/mobile/modules/safety-native/ios/Resources/model-v1.toml
#   core/target/mobile/{android,ios}/...  (mirror, consumed by the Expo config plugin)
set -euo pipefail

CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$CORE_DIR/.." && pwd)"
MODULE_DIR="$REPO_DIR/apps/mobile/modules/safety-native"
ANDROID_DIR="$MODULE_DIR/android/src/main"
IOS_DIR="$MODULE_DIR/ios"
MIRROR_DIR="$CORE_DIR/target/mobile"
MODEL_TOML="$CORE_DIR/config/model-v1.toml"
CRATE="safety-ffi"
LIB="libsafety_ffi"
NAMESPACE="safety"

DO_ANDROID=1
DO_IOS=1
for arg in "$@"; do
  case "$arg" in
    --android-only) DO_IOS=0 ;;
    --ios-only) DO_ANDROID=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[build-mobile]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build-mobile]\033[0m %s\n' "$*" >&2; }

HOST_OS="$(uname -s)"
case "$HOST_OS" in
  Darwin) HOST_DYLIB="$CORE_DIR/target/release/$LIB.dylib" ;;
  *)      HOST_DYLIB="$CORE_DIR/target/release/$LIB.so" ;;
esac

if [[ "$DO_IOS" == 1 && "$HOST_OS" != "Darwin" ]]; then
  if [[ "$DO_ANDROID" == 0 ]]; then
    warn "iOS builds need macOS (Xcode). Nothing to do on $HOST_OS."
    exit 0
  fi
  warn "iOS build skipped: requires macOS/Xcode (host is $HOST_OS). Android only."
  DO_IOS=0
fi

ensure_target() {
  local t="$1"
  if ! rustup target list --installed 2>/dev/null | grep -qx "$t"; then
    log "installing rust target $t"
    rustup target add "$t"
  fi
}

ensure_tool() {
  local bin="$1" crate="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "installing $crate"
    cargo install --locked "$crate"
  fi
}

copy_model() {
  local dest_dir="$1"
  mkdir -p "$dest_dir"
  if [[ -f "$MODEL_TOML" ]]; then
    cp "$MODEL_TOML" "$dest_dir/model-v1.toml"
  else
    warn "config/model-v1.toml not found; skipping model copy to $dest_dir"
  fi
}

cd "$CORE_DIR"

# Host library is needed by uniffi-bindgen (--library mode reads metadata from it).
build_host_lib() {
  log "building host $LIB for uniffi-bindgen"
  cargo build --release -p "$CRATE"
  [[ -f "$HOST_DYLIB" ]] || { warn "expected $HOST_DYLIB after host build"; exit 1; }
}

bindgen() {
  local lang="$1" out="$2"
  mkdir -p "$out"
  cargo run --release -q -p "$CRATE" --bin uniffi-bindgen -- \
    generate --library "$HOST_DYLIB" --language "$lang" --no-format --out-dir "$out"
}

# ------------------------------------------------------------------ Android
if [[ "$DO_ANDROID" == 1 ]]; then
  ensure_target aarch64-linux-android
  ensure_target x86_64-linux-android
  ensure_tool cargo-ndk cargo-ndk

  if [[ -z "${ANDROID_NDK_HOME:-}" && -z "${ANDROID_NDK_ROOT:-}" && -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
    warn "no ANDROID_NDK_HOME / ANDROID_HOME set; cargo-ndk will try to auto-detect the NDK"
  fi

  JNI_OUT="$ANDROID_DIR/jniLibs"
  mkdir -p "$JNI_OUT"
  log "cargo ndk → $JNI_OUT"
  cargo ndk -t arm64-v8a -t x86_64 -o "$JNI_OUT" build --release -p "$CRATE"

  build_host_lib
  KT_OUT="$ANDROID_DIR/java"
  log "kotlin bindings → $KT_OUT"
  bindgen kotlin "$KT_OUT"

  copy_model "$ANDROID_DIR/assets"

  # mirror
  rm -rf "$MIRROR_DIR/android"
  mkdir -p "$MIRROR_DIR/android"
  cp -R "$JNI_OUT" "$MIRROR_DIR/android/jniLibs"
  cp -R "$KT_OUT" "$MIRROR_DIR/android/java"
  copy_model "$MIRROR_DIR/android/assets"
  log "android done"
fi

# ---------------------------------------------------------------------- iOS
if [[ "$DO_IOS" == 1 ]]; then
  ensure_target aarch64-apple-ios
  ensure_target aarch64-apple-ios-sim
  ensure_target x86_64-apple-ios
  command -v xcodebuild >/dev/null || { warn "xcodebuild not found; install Xcode"; exit 1; }

  for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
    log "cargo build --target $t"
    cargo build --release --target "$t" -p "$CRATE"
  done

  [[ -f "$HOST_DYLIB" ]] || build_host_lib

  GEN_OUT="$IOS_DIR/Generated"
  rm -rf "$GEN_OUT"
  log "swift bindings → $GEN_OUT"
  bindgen swift "$GEN_OUT"
  # uniffi emits <ns>FFI.h and <ns>FFI.modulemap; xcframework headers need module.modulemap.
  cat > "$GEN_OUT/module.modulemap" <<MM
module ${NAMESPACE}FFI {
  header "${NAMESPACE}FFI.h"
  export *
}
MM
  rm -f "$GEN_OUT/${NAMESPACE}FFI.modulemap"

  STAGE="$CORE_DIR/target/ios-stage"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/sim" "$STAGE/headers"
  cp "$GEN_OUT/${NAMESPACE}FFI.h" "$GEN_OUT/module.modulemap" "$STAGE/headers/"

  log "lipo simulator slices"
  lipo -create \
    "target/aarch64-apple-ios-sim/release/$LIB.a" \
    "target/x86_64-apple-ios/release/$LIB.a" \
    -output "$STAGE/sim/$LIB.a"

  XCF_OUT="$IOS_DIR/Frameworks/$NAMESPACE.xcframework"
  rm -rf "$XCF_OUT"
  mkdir -p "$IOS_DIR/Frameworks"
  log "xcodebuild -create-xcframework → $XCF_OUT"
  xcodebuild -create-xcframework \
    -library "target/aarch64-apple-ios/release/$LIB.a" -headers "$STAGE/headers" \
    -library "$STAGE/sim/$LIB.a" -headers "$STAGE/headers" \
    -output "$XCF_OUT"

  copy_model "$IOS_DIR/Resources"

  rm -rf "$MIRROR_DIR/ios"
  mkdir -p "$MIRROR_DIR/ios"
  cp -R "$XCF_OUT" "$MIRROR_DIR/ios/"
  cp -R "$GEN_OUT" "$MIRROR_DIR/ios/Generated"
  copy_model "$MIRROR_DIR/ios/Resources"
  log "ios done"
fi

log "artifacts mirrored under $MIRROR_DIR"
