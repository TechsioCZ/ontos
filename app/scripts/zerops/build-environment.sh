# Sourced by build-app.sh (POSIX sh). A unit build reads the build variables of these families (unit identities hash
# them: buildEnvironment in delivery-plan.mts): MODERN_*, MODERNJS_*, ULTRAMODERN_*, PUBLIC_*, RSPACK_*, RSBUILD_*,
# BROWSERSLIST*, ONTOS_*ORIGIN, NODE_ENV, NODE_OPTIONS and BABEL_ENV. Its environment is what the build declares, never what the
# container happens to carry: Zerops gives the build container its project variables (MODERN_PUBLIC_SITE_URL,
# ULTRAMODERN_MF_DEV_ORIGIN and others the runner does not have), and both would be baked into the bundles. So every
# variable of those families is unset unless the caller declares it here; build-app.sh then exports its own
# (ULTRAMODERN_PUBLIC_URL_*, the type-checker switch, NODE_OPTIONS). NODE_ENV stays unset: Rsbuild's build sets
# production. Runner and Zerops run this same file, so they compute the same identities and build the same output.
#
# Declared by the caller (zerops.yaml's app build.envVariables and the stage workflow's build job): the three public
# origins, the deployment environment and the server type-check switch. The release-identity overrides stay
# available as before; identities never hash them.
BUILD_DECLARED_VARIABLES='ONTOS_PUBLIC_ORIGIN ONTOS_STOREFRONT_ORIGIN ONTOS_SHOP_STOREFRONT_ORIGIN
ULTRAMODERN_DEPLOYMENT_ENVIRONMENT ULTRAMODERN_SKIP_SERVER_TYPECHECK ULTRAMODERN_SOURCE_REVISION ULTRAMODERN_BUILD_MARKER'
# Build switches stage does not support (BUILD_SWITCHES in scripts/ci/unit-inputs.mts says what each changes): always
# unset, so a stage build never differs from the identity it is kept under.
BUILD_UNSUPPORTED_SWITCHES='ONTOS_CI_TYPECHECK_SEPARATE ONTOS_INTERNAL_SYMMY_INGRESS'
for build_variable in $BUILD_UNSUPPORTED_SWITCHES; do
  build_variable_set=""
  eval "build_variable_set=\${$build_variable+set}"
  [ "$build_variable_set" = set ] || continue
  unset "$build_variable"
  echo "build environment: dropped unsupported switch $build_variable"
done

# Names only, one per line; a multi-line value cannot fake a name because each name is checked to be set.
for build_variable in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort -u); do
  case "$build_variable" in
    MODERN_* | MODERNJS_* | ULTRAMODERN_* | PUBLIC_* | RSPACK_* | RSBUILD_* | BROWSERSLIST* | ONTOS_*ORIGIN | NODE_ENV | NODE_OPTIONS | BABEL_ENV) ;;
    *) continue ;;
  esac
  case " $(printf '%s' "$BUILD_DECLARED_VARIABLES" | tr '\n' ' ') " in
    *" $build_variable "*) continue ;;
  esac
  build_variable_set=""
  eval "build_variable_set=\${$build_variable+set}"
  [ "$build_variable_set" = set ] || continue
  unset "$build_variable"
  echo "build environment: dropped undeclared $build_variable"
done
unset build_variable build_variable_set
