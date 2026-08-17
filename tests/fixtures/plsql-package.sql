-- Oracle対応 Phase 1 の受け入れ用サンプル。
-- v2 の SQLMegane が丸ごと「解析対象外」にしていた、実務でよくある形の
-- PL/SQL パッケージ（仕様部 + 本体）。AUTONOMOUS_TRANSACTION / CURSOR /
-- BULK COLLECT / FORALL + SAVE EXCEPTIONS / 2階層の EXCEPTION 節 / `/` 区切りを含む。

-- 1. パッケージ仕様部 (Specification)
CREATE OR REPLACE PACKAGE pkg_order_batch AS
    PROCEDURE process_pending_orders(
        p_limit_size IN NUMBER DEFAULT 1000
    );
END pkg_order_batch;
/

-- 2. パッケージ本体 (Body)
CREATE OR REPLACE PACKAGE BODY pkg_order_batch AS

    -- 【ポイント1】自立型トランザクションによるログ記録ルーチン
    -- メイン処理がロールバックされてもログはDBに書き込まれます
    PROCEDURE log_message(
        p_proc_name IN VARCHAR2,
        p_status    IN VARCHAR2,
        p_msg       IN VARCHAR2
    ) IS
        PRAGMA AUTONOMOUS_TRANSACTION;
    BEGIN
        INSERT INTO process_log (process_name, status, message, logged_at)
        VALUES (p_proc_name, p_status, p_msg, SYSTIMESTAMP);
        COMMIT;
    EXCEPTION
        WHEN OTHERS THEN
            ROLLBACK;
    END log_message;

    -- メインの注文更新処理
    PROCEDURE process_pending_orders(
        p_limit_size IN NUMBER DEFAULT 1000
    ) IS
        -- 処理対象を抽出するカーソル
        CURSOR c_orders IS
            SELECT order_id, customer_id, total_amount
            FROM orders
            WHERE status = 'PENDING';

        -- コレクション型の定義
        TYPE t_order_list IS TABLE OF c_orders%ROWTYPE;
        v_orders t_order_list;

        -- BULK EXCEPTIONS 用の例外宣言
        v_error_count NUMBER := 0;
        dml_errors EXCEPTION;
        PRAGMA EXCEPTION_INIT(dml_errors, -24381);
    BEGIN
        log_message('process_pending_orders', 'INFO', 'バッチ処理を開始しました');

        OPEN c_orders;
        LOOP
            -- 【ポイント2】LIMIT付き BULK COLLECT でメモリ圧迫を回避しつつ高速ロード
            FETCH c_orders BULK COLLECT INTO v_orders LIMIT p_limit_size;
            EXIT WHEN v_orders.COUNT = 0;

            BEGIN
                -- 【ポイント3】FORALL + SAVE EXCEPTIONS で一部行の更新エラー時も処理を継続
                FORALL i IN 1..v_orders.COUNT SAVE EXCEPTIONS
                    UPDATE orders
                       SET status = 'PROCESSED',
                           processed_at = SYSDATE
                     WHERE order_id = v_orders(i).order_id;

            EXCEPTION
                WHEN dml_errors THEN
                    -- エラーが発生したレコードの数を取得してログへ記録
                    v_error_count := SQL%BULK_EXCEPTIONS.COUNT;
                    FOR j IN 1..v_error_count LOOP
                        log_message(
                            'process_pending_orders',
                            'WARN',
                            'Order ID: ' || v_orders(SQL%BULK_EXCEPTIONS(j).ERROR_INDEX).order_id ||
                            ' Error: ' || SQLERRM(-SQL%BULK_EXCEPTIONS(j).ERROR_CODE)
                        );
                    END LOOP;
            END;

            -- 正常行のみ COMMIT
            COMMIT;
        END LOOP;
        CLOSE c_orders;

        log_message('process_pending_orders', 'INFO', 'バッチ処理が正常終了しました');

    EXCEPTION
        WHEN OTHERS THEN
            IF c_orders%ISOPEN THEN
                CLOSE c_orders;
            END IF;
            ROLLBACK;
            log_message('process_pending_orders', 'FATAL', SQLERRM);
            RAISE;
    END process_pending_orders;

END pkg_order_batch;
/
