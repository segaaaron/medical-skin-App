-- La aplicación NO es dueña de las tablas ni superusuario.
-- Si lo fuera, la seguridad a nivel de fila (RLS) no se le aplicaría y el aislamiento
-- multi-tenant sería una ilusión. Por eso hay dos usuarios:
--   medskin_owner  migra y es dueño del esquema
--   medskin        es el que usa la API en tiempo de ejecución
CREATE ROLE medskin LOGIN PASSWORD 'dev_local_only';

GRANT CONNECT ON DATABASE medskin TO medskin;
GRANT USAGE ON SCHEMA public TO medskin;

-- lo que exista ahora y lo que cree el dueño después
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medskin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO medskin;
ALTER DEFAULT PRIVILEGES FOR ROLE medskin_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medskin;
ALTER DEFAULT PRIVILEGES FOR ROLE medskin_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO medskin;

-- comprobación de que no se cuela por la puerta de atrás
ALTER ROLE medskin NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
