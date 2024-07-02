DROP TABLE IF EXISTS Directqs;
CREATE TABLE IF NOT EXISTS Directqs (id INTEGER PRIMARY KEY, sender_id NUMBER NOT NULL, recipient_id NUMBER NOT NULL, q_id TEXT NOT NULL, sent_at NUMBER DEFAULT CURRENT_TIMESTAMP, answered BOOLEAN, removed BOOLEAN, cost NUMBER, tx TEXT, cast TEXT);
INSERT INTO Directqs (id, sender_id, recipient_id, q_id, sent_at) VALUES (1, 2, 1, 1, 000000001);

-- DROP TABLE IF EXISTS Users;
-- CREATE TABLE IF NOT EXISTS Users (id INTEGER PRIMARY KEY, fname TEXT, fid NUMBER, points_balance NUMBER NOT NULL, points_allowance NUMBER NOT NULL, created_at NUMBER DEFAULT CURRENT_TIMESTAMP );
-- INSERT INTO Users (id, fname, fid, points_balance, points_allowance, created_at) VALUES (1, 'zoo', 10215, 40, 10, 000000001);
