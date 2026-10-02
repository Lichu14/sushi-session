import { randomBytes, createHash } from 'node:crypto';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { parseCheckInQr } from '../../mobile/src/core/qr.ts';

export const DEV_QR = Object.freeze({
  restaurantName: 'Sushi Session Test',
  restaurantSlug: 'dev-sushi-session-test',
  locationName: 'Local de prueba',
  locationSlug: 'dev-local-de-prueba',
  label: 'DEV_TEST_QR',
});

export function ownerArgument(args) {
  if (!args.length) return undefined;
  if (
    args.length !== 2 ||
    args[0] !== '--owner-user-id' ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(args[1])
  ) {
    throw new Error('Usá únicamente --owner-user-id UUID, o ningún argumento.');
  }
  return args[1].toLowerCase();
}

export function decodeDevelopmentQr(png) {
  const image = PNG.sync.read(png);
  const decoded = jsQR(
    new Uint8ClampedArray(image.data),
    image.width,
    image.height,
  );
  if (!decoded) throw new Error('El PNG generado no se pudo decodificar.');
  const parsed = parseCheckInQr(decoded.data);
  const object = JSON.parse(decoded.data);
  if (Object.keys(object).sort().join(',') !== 'locationId,token,v')
    throw new Error('El QR contiene campos inesperados.');
  return parsed;
}

// Caller owns the transaction, development-only connection guard and PNG publishing.
// fixture overrides exist solely for isolated integration tests, never CLI arguments.
export async function prepareDevelopmentQr(tx, ownerUserId, fixture = DEV_QR) {
  // Serialize rotation across processes/workspaces on this development database.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(1937077096, 5)`;
  if (
    ownerUserId &&
    !(await tx.user.findFirst({
      where: { id: ownerUserId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    }))
  )
    throw new Error('El OWNER debe ser un User existente y activo.');

  let restaurant = await tx.restaurant.findUnique({
    where: { slug: fixture.restaurantSlug },
  });
  if (
    restaurant &&
    (restaurant.name !== fixture.restaurantName ||
      restaurant.status !== 'ACTIVE')
  )
    throw new Error(
      'El slug de desarrollo está ocupado o el restaurante no está activo.',
    );
  restaurant ??= await tx.restaurant.create({
    data: {
      name: fixture.restaurantName,
      slug: fixture.restaurantSlug,
      status: 'ACTIVE',
    },
  });
  let location = await tx.restaurantLocation.findUnique({
    where: {
      restaurantId_slug: {
        restaurantId: restaurant.id,
        slug: fixture.locationSlug,
      },
    },
  });
  if (
    location &&
    (location.name !== fixture.locationName || location.status !== 'ACTIVE')
  )
    throw new Error(
      'El slug de desarrollo está ocupado o la sucursal no está activa.',
    );
  location ??= await tx.restaurantLocation.create({
    data: {
      restaurantId: restaurant.id,
      name: fixture.locationName,
      slug: fixture.locationSlug,
      addressLine1: 'Dirección ficticia para pruebas',
      city: 'Ciudad de prueba',
      region: 'Región de prueba',
      countryCode: 'AR',
      timeZone: 'America/Argentina/Buenos_Aires',
      status: 'ACTIVE',
    },
  });
  const [{ now }] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
  let membership;
  if (ownerUserId) {
    const previous = await tx.merchantMembership.findUnique({
      where: {
        userId_restaurantId: {
          userId: ownerUserId,
          restaurantId: restaurant.id,
        },
      },
    });
    membership = await tx.merchantMembership.upsert({
      where: {
        userId_restaurantId: {
          userId: ownerUserId,
          restaurantId: restaurant.id,
        },
      },
      create: {
        userId: ownerUserId,
        restaurantId: restaurant.id,
        role: 'OWNER',
        status: 'ACTIVE',
        scopeType: 'ALL_LOCATIONS',
        invitedAt: now,
        acceptedAt: now,
      },
      update: {
        role: 'OWNER',
        status: 'ACTIVE',
        scopeType: 'ALL_LOCATIONS',
        acceptedAt: previous?.acceptedAt ?? now,
      },
    });
    // Phase 1 allows this scope conversion atomically; ALL must have no bridge rows.
    await tx.merchantMembershipLocation.deleteMany({
      where: { membershipId: membership.id },
    });
  }
  await tx.checkInCode.updateMany({
    where: {
      locationId: location.id,
      label: fixture.label,
      status: { not: 'REVOKED' },
    },
    data: { status: 'REVOKED', revokedAt: now },
  });
  const token = randomBytes(32).toString('base64url'); // 256 bits of entropy
  const code = await tx.checkInCode.create({
    data: {
      locationId: location.id,
      label: fixture.label,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      mode: 'STATIC',
      status: 'ACTIVE',
      validFrom: now,
      validUntil: null,
      maxUses: null,
      ...(membership ? { createdByMembershipId: membership.id } : {}),
    },
  });
  const payload = JSON.stringify({ v: 1, locationId: location.id, token });
  const png = await QRCode.toBuffer(payload, {
    type: 'png',
    width: 768,
    margin: 4,
    errorCorrectionLevel: 'M',
  });
  const parsed = decodeDevelopmentQr(png);
  if (parsed.locationId !== location.id || parsed.token !== token)
    throw new Error('El PNG no coincide con el código generado.');
  // Never return the plaintext token/hash in the CLI metadata.
  return {
    png,
    metadata: {
      restaurant: restaurant.name,
      location: location.name,
      restaurantId: restaurant.id,
      locationId: location.id,
      checkInCodeId: code.id,
    },
  };
}
