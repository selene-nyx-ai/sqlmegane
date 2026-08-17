-- ============================================================
-- 受注バッチ処理パッケージ（Oracle PL/SQL・SQLMegane検証用サンプル）
-- 仕様部 + 本体、AUTONOMOUS_TRANSACTION / CURSOR / BULK COLLECT /
-- FORALL + SAVE EXCEPTIONS / EXCEPTION節 / `/` 区切りを含む。
-- ============================================================

CREATE OR REPLACE PACKAGE pkg_order_batch AS

  g_batch_name CONSTANT VARCHAR2(30) := 'ORDER_BATCH';

  -- 保留中の受注をまとめて処理する
  PROCEDURE process_pending_orders(p_limit_size IN PLS_INTEGER DEFAULT 1000);

  FUNCTION get_pending_count RETURN NUMBER;

END pkg_order_batch;
/

CREATE OR REPLACE PACKAGE BODY pkg_order_batch AS

  TYPE t_order_rec IS RECORD (
    order_id  orders.order_id%TYPE,
    cust_id   orders.cust_id%TYPE,
    amount    orders.amount%TYPE
  );
  TYPE t_order_tab IS TABLE OF t_order_rec INDEX BY PLS_INTEGER;

  CURSOR c_pending IS
    SELECT order_id, cust_id, amount
      FROM orders
     WHERE status = 'PENDING'
       AND created_at < SYSDATE - 1
     ORDER BY order_id;

  -- 監査ログは本処理がROLLBACKされても残したいので自律型トランザクションにする
  PROCEDURE write_audit_log(p_message IN VARCHAR2) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO batch_audit_log (log_id, batch_name, message, logged_at)
    VALUES (seq_batch_audit_log.NEXTVAL, g_batch_name, p_message, SYSTIMESTAMP);
    COMMIT;
  END write_audit_log;

  PROCEDURE process_pending_orders(p_limit_size IN PLS_INTEGER DEFAULT 1000) IS
    v_orders t_order_tab;
    v_errors PLS_INTEGER := 0;
    -- q'記法の中にセミコロンとクォートが入っている（文の切り出しが壊れやすい箇所）
    v_note   VARCHAR2(200) := q'[status='PENDING'; 要確認]';
  BEGIN
    OPEN c_pending;
    FETCH c_pending BULK COLLECT INTO v_orders LIMIT p_limit_size;
    CLOSE c_pending;

    IF v_orders.COUNT = 0 THEN
      write_audit_log('対象なし; 後続処理なし: ' || v_note);
      RETURN;
    END IF;

    /* このコメントの中に BEGIN と END; を書いても構造には影響しない */
    FORALL i IN 1 .. v_orders.COUNT SAVE EXCEPTIONS
      UPDATE orders
         SET status = 'PROCESSED',
             updated_at = SYSDATE
       WHERE order_id = v_orders(i).order_id;

    COMMIT;
    write_audit_log('処理件数: ' || SQL%ROWCOUNT);

  EXCEPTION
    WHEN OTHERS THEN
      v_errors := SQL%BULK_EXCEPTIONS.COUNT;
      ROLLBACK;
      write_audit_log('エラー ' || v_errors || '件');
      RAISE;
  END process_pending_orders;

  FUNCTION get_pending_count RETURN NUMBER IS
    v_cnt NUMBER;
  BEGIN
    SELECT COUNT(*)
      INTO v_cnt
      FROM orders
     WHERE status = 'PENDING';
    RETURN v_cnt;
  END get_pending_count;

END pkg_order_batch;
/
