import { permissionModule } from '@hmis/db';
import { permission, role, rolePermission } from '@hmis/db/schema';
import { PERMISSIONS, RESTRICTED_PERMISSIONS, uuidSchema, type Permission } from '@hmis/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { appError, protectedProcedure } from '../../init';
import { assertOwner, assertUserManagerRemains, protectedRoleIds } from './guards';

const restricted: ReadonlySet<string> = new Set(RESTRICTED_PERMISSIONS);

const roleKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{2,39}$/, 'validation.roleKey');
const roleNameSchema = z.string().trim().min(2, 'validation.required').max(60);

export const roleProcedures = {
  /** Active roles for the user editor's role picker. */
  listRoles: protectedProcedure.meta({ permission: 'admin.users.manage' }).query(({ ctx }) =>
    ctx
      .db()
      .select({
        id: role.id,
        key: role.key,
        name: role.name,
        nameHi: role.nameHi,
        isSystem: role.isSystem,
      })
      .from(role)
      .where(and(eq(role.facilityId, ctx.auth.facilityId), eq(role.isActive, true)))
      .orderBy(asc(role.name)),
  ),

  /** Role → permission matrix of the facility (docs/03 §3). */
  getRoleMatrix: protectedProcedure
    .meta({ permission: 'admin.roles.manage' })
    .query(async ({ ctx }) => {
      const db = ctx.db();
      const roles = await db
        .select({
          id: role.id,
          key: role.key,
          name: role.name,
          nameHi: role.nameHi,
          isSystem: role.isSystem,
          isActive: role.isActive,
        })
        .from(role)
        .where(eq(role.facilityId, ctx.auth.facilityId))
        .orderBy(asc(role.createdAt));
      const grants = await db
        .select({ roleId: rolePermission.roleId, key: permission.key })
        .from(rolePermission)
        .innerJoin(permission, eq(permission.id, rolePermission.permissionId))
        .where(
          and(eq(rolePermission.facilityId, ctx.auth.facilityId), isNull(rolePermission.revokedAt)),
        );
      return {
        permissions: PERMISSIONS.map((key) => ({
          key,
          module: permissionModule(key),
          restricted: restricted.has(key),
        })),
        roles: roles.map((r) => ({
          ...r,
          permissions: grants.filter((g) => g.roleId === r.id).map((g) => g.key as Permission),
        })),
      };
    }),

  createRole: protectedProcedure
    .meta({ permission: 'admin.roles.manage' })
    .input(
      z.object({ key: roleKeySchema, name: roleNameSchema, nameHi: roleNameSchema.nullable() }),
    )
    .mutation(async ({ ctx, input }) => {
      const id = uuidv7();
      const inserted = await ctx.tx((tx) =>
        tx
          .insert(role)
          .values({
            id,
            facilityId: ctx.auth.facilityId,
            key: input.key,
            name: input.name,
            nameHi: input.nameHi,
          })
          .onConflictDoNothing({ target: [role.facilityId, role.key] })
          .returning({ id: role.id }),
      );
      if (inserted.length === 0) throw appError('CONFLICT', 'errors.admin.roleKeyTaken');
      return { id };
    }),

  /** Rename or (de)activate. Roles are never deleted; a deactivated role grants nothing. */
  updateRole: protectedProcedure
    .meta({ permission: 'admin.roles.manage' })
    .input(
      z.object({
        roleId: uuidSchema,
        name: roleNameSchema,
        nameHi: roleNameSchema.nullable(),
        isActive: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.tx(async (tx) => {
        if ((await protectedRoleIds(tx, [input.roleId])).size > 0) assertOwner(ctx.auth);
        const updated = await tx
          .update(role)
          .set({ name: input.name, nameHi: input.nameHi, isActive: input.isActive })
          .where(and(eq(role.id, input.roleId), eq(role.facilityId, ctx.auth.facilityId)))
          .returning({ id: role.id });
        if (updated.length === 0) throw appError('NOT_FOUND', 'errors.notFound');
        await assertUserManagerRemains(tx, ctx.auth.facilityId);
      });
      return { ok: true as const };
    }),

  /**
   * Replaces a role's grants. Restricted MTP keys cannot be changed here (AGENTS.md rule 8):
   * MTP access is given only by assigning the `mtp_doctor` role to a user.
   */
  setRolePermissions: protectedProcedure
    .meta({ permission: 'admin.roles.manage' })
    .input(
      z.object({
        roleId: uuidSchema,
        permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = ctx.now();
      await ctx.tx(async (tx) => {
        const [r] = await tx
          .select({ id: role.id })
          .from(role)
          .where(and(eq(role.id, input.roleId), eq(role.facilityId, ctx.auth.facilityId)));
        if (!r) throw appError('NOT_FOUND', 'errors.notFound');
        if ((await protectedRoleIds(tx, [r.id])).size > 0) assertOwner(ctx.auth);
        const current = await tx
          .select({ id: rolePermission.id, key: permission.key })
          .from(rolePermission)
          .innerJoin(permission, eq(permission.id, rolePermission.permissionId))
          .where(and(eq(rolePermission.roleId, r.id), isNull(rolePermission.revokedAt)));
        const wanted = new Set<string>(input.permissions);
        const have = new Set(current.map((c) => c.key));
        const removed = current.filter((c) => !wanted.has(c.key));
        const added = [...wanted].filter((k) => !have.has(k));
        if ([...removed.map((c) => c.key), ...added].some((k) => restricted.has(k))) {
          throw appError('FORBIDDEN', 'errors.admin.restrictedPermission');
        }
        for (const c of removed) {
          await tx
            .update(rolePermission)
            .set({ revokedAt: now, revokedBy: ctx.auth.userId })
            .where(eq(rolePermission.id, c.id));
        }
        if (added.length > 0) {
          const perms = await tx
            .select({ id: permission.id, key: permission.key })
            .from(permission)
            .where(
              and(eq(permission.facilityId, ctx.auth.facilityId), inArray(permission.key, added)),
            );
          if (perms.length !== added.length) throw appError('NOT_FOUND', 'errors.notFound');
          await tx.insert(rolePermission).values(
            perms.map((p) => ({
              id: uuidv7(),
              facilityId: ctx.auth.facilityId,
              roleId: r.id,
              permissionId: p.id,
            })),
          );
        }
        await assertUserManagerRemains(tx, ctx.auth.facilityId);
      });
      return { ok: true as const };
    }),
};
