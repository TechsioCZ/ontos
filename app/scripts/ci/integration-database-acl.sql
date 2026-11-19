SELECT coalesce(grantor_role.rolname, 'PUBLIC'), coalesce(grantee_role.rolname, 'PUBLIC'),
  acl.privilege_type, acl.is_grantable
FROM pg_database d
CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) acl
LEFT JOIN pg_roles grantor_role ON grantor_role.oid = acl.grantor
LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
WHERE d.datname = current_database()
ORDER BY 1, 2, 3, 4;
